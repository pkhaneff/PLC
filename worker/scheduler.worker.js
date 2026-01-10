const { logger } = require('../logger/logger');
const CellRepository = require('../repository/cell.repository');
const redisClient = require('../redis/init.redis');
const shuttleTaskQueueService = require('../modules/SHUTTLE/shuttleTaskQueueService');
const ReservationService = require('../modules/COMMON/reservationService');

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
      logger.info(`[Scheduler] Popped task from staging queue for pickup: ${stagedTask.pickupNodeQr}`);

      // 2. Get a page of available endNodes
      const candidateNodes = await CellRepository.getAvailableEndNodes(1, ENDNODE_PAGE_SIZE);
      if (!candidateNodes || candidateNodes.length === 0) {
        logger.warn('[Scheduler] No available end-nodes found. Re-queuing task.');
        await redisClient.lPush(TASK_STAGING_QUEUE_KEY, stagedTaskJSON);
        this.isProcessing = false;
        return;
      }

      logger.debug(`[Scheduler] Found ${candidateNodes.length} candidate end-nodes. Attempting to lock one...`);

      let isLockAcquired = false;
      // 3. Loop through candidateNodes and try to acquire lock
      for (const node of candidateNodes) {
        const resourceKey = `endnode:lock:${node.id}`;
        // Use pickupNodeQr in ownerId
        const ownerId = `task_for_${stagedTask.pickupNodeQr}_${stagedTask.itemInfo.ID || ''}`;

        const lockAcquired = await ReservationService.acquireLock(resourceKey, ownerId, LOCK_TIMEOUT);

        if (lockAcquired) {
          logger.info(`[Scheduler] Successfully acquired lock for end-node ${node.name} (ID: ${node.id}, QR: ${node.qr_code})`);

          // 4. If lock acquired, register the real task and break loop
          const finalTaskData = {
            ...stagedTask,
            endNodeQr: node.qr_code, // Use QR code
            endNodeFloorId: node.floor_id,
            endNodeCol: node.col,
            endNodeRow: node.row,
          };

          await shuttleTaskQueueService.registerTask(finalTaskData);
          isLockAcquired = true;
          break; // Exit the loop once one task is scheduled
        }
      }

      if (!isLockAcquired) {
        // If no node could be locked, push the task back to the front of the queue
        logger.warn('[Scheduler] All candidate end-nodes were locked. Re-queuing task.');
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