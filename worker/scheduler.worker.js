const { logger } = require('../logger/logger');
const CellRepository = require('../repository/cell.repository');
const redisClient = require('../redis/init.redis');
const shuttleTaskQueueService = require('../modules/SHUTTLE/shuttleTaskQueueService');
const ReservationService = require('../modules/COMMON/reservationService');
const cellService = require('../modules/SHUTTLE/cellService');

const SCHEDULER_INTERVAL = 5000;
const ENDNODE_PAGE_SIZE = 10;
const LOCK_TIMEOUT = 300;
const TASK_STAGING_QUEUE_KEY = 'task:staging_queue';

class Scheduler {
  constructor() {
    this.isRunning = false;
    this.timer = null;
    this.isProcessing = false;
  }

  run() {
    if (this.isRunning) {
      logger.warn('[Scheduler] Attempted to start an already running scheduler.');
      return;
    }

    logger.info(`[Scheduler] Starting scheduler with interval: ${SCHEDULER_INTERVAL}ms.`);
    this.isRunning = true;
    this.timer = setInterval(() => this.processStagingQueue(), SCHEDULER_INTERVAL);
  }

  stop() {
    if (!this.isRunning) {
      logger.warn('[Scheduler] Attempted to stop a non-running scheduler.');
      return;
    }
    logger.info('[Scheduler] Stopping scheduler.');
    clearInterval(this.timer);
    this.isRunning = false;
    this.timer = null;
  }

  /**
   * The core logic of the scheduler. In each cycle, it attempts to process one task
   * from the staging queue.
   */
  async processStagingQueue() {
    if (this.isProcessing) {
      logger.debug('[Scheduler] Previous cycle is still running. Skipping.');
      return;
    }
    this.isProcessing = true;
    logger.debug('[Scheduler] Running processing cycle...');

    let stagedTaskJSON = null;
    try {
      // DEBUGGING STEP: Check queue length before popping
      const queueLength = await redisClient.lLen(TASK_STAGING_QUEUE_KEY);
      logger.info(`[Scheduler] Checking staging queue. Found ${queueLength} tasks.`);

      if (queueLength === 0) {
        logger.debug('[Scheduler] Staging queue is empty. Nothing to schedule.');
        this.isProcessing = false;
        return;
      }

      // 1. Get next task from the staging queue
      stagedTaskJSON = await redisClient.rPop(TASK_STAGING_QUEUE_KEY);

      // This case should theoretically not be hit if lLen > 0, but as a safeguard:
      if (!stagedTaskJSON) {
        logger.warn('[Scheduler] lLen reported items, but RPOP returned null. A race condition might have occurred.');
        this.isProcessing = false;
        return;
      }

      const stagedTask = JSON.parse(stagedTaskJSON);
      const pickupName = await cellService.getCachedDisplayName(stagedTask.pickupNodeQr, stagedTask.pickupNodeFloorId);
      logger.info(`[Scheduler] Popped task from staging queue for pickup: ${pickupName}`);

      // === ROW COORDINATION LOGIC ===
      // Xác định targetRow dựa trên batch coordination khi có nhiều shuttle
      const ShuttleCounterService = require('../modules/SHUTTLE/ShuttleCounterService');
      const RowCoordinationService = require('../modules/SHUTTLE/RowCoordinationService');

      const activeShuttleCount = await ShuttleCounterService.getCount();
      const enforceRowCoordination = activeShuttleCount >= 2;

      let targetRow = stagedTask.targetRow; // Có thể đã được set từ trước
      let targetFloor = stagedTask.targetFloor || stagedTask.pickupNodeFloorId;
      let batchId = stagedTask.batchId;

      if (enforceRowCoordination) {
        // Tạo/lấy batchId dựa trên pickup area
        const batchKey = `batch:pickup:${stagedTask.pickupNodeQr}`;
        batchId = await redisClient.get(batchKey);

        if (!batchId) {
          batchId = `batch_${stagedTask.pickupNodeQr}_${Date.now()}`;
          await redisClient.set(batchKey, batchId, { EX: 3600 });
          logger.info(`[Scheduler] ✅ Created new batchId ${batchId} for pickup ${pickupName}`);
        } else {
          logger.info(`[Scheduler] Using existing batchId ${batchId} for pickup ${pickupName}`);
        }

        // Nếu chưa có targetRow, cần xác định row cho batch
        if (!targetRow) {
          // Tìm row khả dụng đầu tiên (FIFO)
          const availableNodes = await CellRepository.findAvailableNodesByFIFO(
            stagedTask.palletType,
            targetFloor
          );

          if (!availableNodes || availableNodes.length === 0) {
            logger.warn(`[Scheduler] No available nodes for palletType ${stagedTask.palletType}. Re-queuing.`);
            await redisClient.lPush(TASK_STAGING_QUEUE_KEY, stagedTaskJSON);
            this.isProcessing = false;
            return;
          }

          // Lấy row của node đầu tiên làm targetRow
          const firstAvailableRow = availableNodes[0].row;

          // Gán row cho batch
          targetRow = await RowCoordinationService.assignRowForBatch(
            batchId,
            availableNodes[0].qr_code, // Dùng QR của node đầu tiên
            targetFloor
          );

          if (!targetRow) {
            targetRow = firstAvailableRow; // Fallback
          }

          logger.info(`[Scheduler] 🎯 Batch ${batchId} assigned to row ${targetRow}`);
        } else {
          // Đã có targetRow (từ batch trước đó), verify với RowCoordinationService
          const assignedRow = await RowCoordinationService.getAssignedRow(batchId);
          if (assignedRow && assignedRow !== targetRow) {
            logger.warn(`[Scheduler] Task has targetRow ${targetRow} but batch ${batchId} is assigned to row ${assignedRow}. Using batch row.`);
            targetRow = assignedRow;
          }
        }
      } else {
        // Single shuttle mode - dùng FIFO row nếu chưa có targetRow
        if (!targetRow) {
          const availableNodes = await CellRepository.findAvailableNodesByFIFO(
            stagedTask.palletType,
            targetFloor
          );

          if (!availableNodes || availableNodes.length === 0) {
            logger.warn(`[Scheduler] No available nodes for palletType ${stagedTask.palletType}. Re-queuing.`);
            await redisClient.lPush(TASK_STAGING_QUEUE_KEY, stagedTaskJSON);
            this.isProcessing = false;
            return;
          }

          targetRow = availableNodes[0].row;
          logger.info(`[Scheduler] Single shuttle mode - using FIFO row ${targetRow}`);
        }
      }

      // 2. Query endNode CHỈ trong targetRow (row-aware)
      if (!targetRow || !targetFloor) {
        logger.error(`[Scheduler] Task missing targetRow or targetFloor metadata. Re-queuing.`);
        await redisClient.lPush(TASK_STAGING_QUEUE_KEY, stagedTaskJSON);
        this.isProcessing = false;
        return;
      }

      const candidateNodes = await CellRepository.getAvailableNodesInRow(
        targetFloor,
        targetRow,
        stagedTask.palletType
      );

      if (!candidateNodes || candidateNodes.length === 0) {
        logger.warn(`[Scheduler] No available nodes in row ${targetRow} (floor ${targetFloor}). Re-queuing task.`);
        await redisClient.lPush(TASK_STAGING_QUEUE_KEY, stagedTaskJSON);
        this.isProcessing = false;
        return;
      }

      logger.debug(`[Scheduler] Found ${candidateNodes.length} candidate nodes in row ${targetRow}. Attempting to lock one...`);

      let isLockAcquired = false;
      // 3. Loop through candidateNodes and try to acquire lock (từ trái qua phải)
      for (const node of candidateNodes) {
        const resourceKey = `endnode:lock:${node.id}`;
        const ownerId = `task_for_${stagedTask.pickupNodeQr}_${stagedTask.itemInfo.ID || ''}`;

        const lockAcquired = await ReservationService.acquireLock(resourceKey, ownerId, LOCK_TIMEOUT);

        if (lockAcquired) {
          const endNodeName = await cellService.getCachedDisplayName(node.qr_code, node.floor_id);
          logger.info(`[Scheduler] Successfully acquired lock for end-node ${endNodeName} (row ${targetRow}, col ${node.col})`);

          // 4. If lock acquired, register the real task and break loop
          const finalTaskData = {
            ...stagedTask,
            batchId: batchId, // Add batchId for coordination
            endNodeQr: node.qr_code,
            endNodeFloorId: node.floor_id,
            endNodeCol: node.col,
            endNodeRow: node.row,
            palletType: stagedTask.palletType,
            targetRow: targetRow, // Preserve metadata
            targetFloor: targetFloor
          };

          await shuttleTaskQueueService.registerTask(finalTaskData);
          isLockAcquired = true;
          break;
        }
      }

      if (!isLockAcquired) {
        // If no node could be locked, push the task back to the front of the queue
        logger.warn(`[Scheduler] All nodes in row ${targetRow} were locked. Re-queuing task.`);
        await redisClient.lPush(TASK_STAGING_QUEUE_KEY, stagedTaskJSON);
      }

    } catch (error) {
      logger.error('[Scheduler] Error during processing cycle:', error);
      // If an error occurred after popping a task, try to push it back
      if (stagedTaskJSON) {
        logger.info('[Scheduler] Attempting to re-queue task after error.');
        await redisClient.lPush(TASK_STAGING_QUEUE_KEY, stagedTaskJSON);
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

// --- Initialization ---
if (require.main === module) {
  const scheduler = new Scheduler();
  scheduler.run();

  process.on('SIGINT', () => {
    logger.info('[Scheduler] Gracefully shutting down from SIGINT');
    scheduler.stop();
    process.exit(0);
  });
}

module.exports = Scheduler;