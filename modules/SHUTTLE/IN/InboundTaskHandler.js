const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');
const shuttleTaskQueueService = require('../services/shuttleTaskQueueService');
const cellService = require('../services/cellService');
const { updateShuttleState, getShuttleState } = require('../services/shuttleStateCache');
const ReservationService = require('../../COMMON/reservationService');
const ShuttleCounterService = require('../services/ShuttleCounterService');
const RowCoordinationService = require('../services/RowCoordinationService');
const RowDirectionManager = require('../services/RowDirectionManager');
const MissionCoordinatorService = require('../services/MissionCoordinatorService');
const mqttClientService = require('../../../services/mqttClientService');
const PathCacheService = require('../services/PathCacheService');
const { MQTT_TOPICS } = require('../../../config/shuttle.config');
const { cellRepository: CellRepository } = require('../../../core/bootstrap');
const controller = require('../../../controllers/shuttle.controller');

class InboundTaskHandler {
  async handlePickupComplete(taskId, shuttleId, dispatcher) {
    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails) {
      logger.error(`[InboundHandler] Cannot find details for task ${taskId} after pickup.`);
      return;
    }

    const { pickupNodeQr, pickupNodeFloorId, endNodeQr, endNodeFloorId } = taskDetails;
    const taskKey = shuttleTaskQueueService.getTaskKey(taskId);

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
    await redisClient.hSet(taskKey, 'pickupCompleted', 'true');

    // --- ROW COORDINATION LOGIC (THACO SPECIFIC) ---
    const activeShuttleCount = await ShuttleCounterService.updateCounter();
    const enforceOneWay = activeShuttleCount >= 2 || !!taskDetails.batchId;

    let targetRow = null;
    let actualEndNodeQr = endNodeQr;

    if (enforceOneWay) {
      if (taskDetails.batchId) {
        targetRow = await RowCoordinationService.assignRowForBatch(taskDetails.batchId, endNodeQr, endNodeFloorId);
        if (!targetRow) {
          logger.error(`[InboundHandler] Cannot assign row for batch ${taskDetails.batchId}.`);
          await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
          return;
        }

        const isEndNodeInRow = await RowCoordinationService.isNodeInAssignedRow(endNodeQr, endNodeFloorId, targetRow);
        if (!isEndNodeInRow) {
          const nearestNode = await RowCoordinationService.findNearestNodeInRow(
            pickupNodeQr,
            targetRow,
            endNodeFloorId,
          );
          if (!nearestNode) {
            await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
            return;
          }
          actualEndNodeQr = nearestNode;
        }
      } else {
        const endNodeCell = await cellService.getCellByQrCode(endNodeQr, endNodeFloorId);
        if (endNodeCell) {
          targetRow = endNodeCell.row;
        }
      }
    } else {
      const endNodeCell = await cellService.getCellByQrCode(endNodeQr, endNodeFloorId);
      if (endNodeCell) {
        targetRow = endNodeCell.row;
      }
    }

    let requiredDirection = null;
    if (enforceOneWay && targetRow !== null) {
      requiredDirection = await RowDirectionManager.getRowDirection(targetRow, endNodeFloorId);
      if (!requiredDirection) {
        const pickupCell = await cellService.getCellByQrCode(pickupNodeQr, endNodeFloorId);
        const endCell = await cellService.getCellByQrCode(actualEndNodeQr, endNodeFloorId);
        requiredDirection = pickupCell && endCell && endCell.col < pickupCell.col ? 2 : 1;
      }

      const locked = await RowDirectionManager.lockRowDirection(
        targetRow,
        endNodeFloorId,
        requiredDirection,
        shuttleId,
      );
      if (!locked) {
        await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
        return;
      }
    }
    // --- END ROW COORDINATION ---

    try {
      // 1. Calculate Path
      const missionPayload = await MissionCoordinatorService.calculateNextSegment(
        shuttleId,
        actualEndNodeQr,
        endNodeFloorId,
        {
          taskId: taskId,
          onArrival: 'TASK_COMPLETE',
          pickupNodeQr: pickupNodeQr,
          endNodeQr: actualEndNodeQr,
          itemInfo: taskDetails.itemInfo,
          isCarrying: true,
          enforceOneWay: enforceOneWay,
          targetRow: targetRow,
          requiredDirection: requiredDirection,
        },
      );

      // 2. Update shuttle package state in Redis
      const currentShuttleState = (await getShuttleState(shuttleId)) || {};
      await updateShuttleState(shuttleId, { ...currentShuttleState, isCarrying: true, packageStatus: 1 });
      await redisClient.hSet(taskKey, 'isCarrying', 'true');

      // 3. Send mission
      const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;
      if (dispatcher && dispatcher.publishMissionWithRetry) {
        await dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
      } else {
        mqttClientService.publishToTopic(missionTopic, missionPayload);
      }
    } catch (error) {
      logger.error(`[InboundHandler] Error in unified Path 2 calculation: ${error.message}`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
    }
  }

  async handleTaskComplete(taskId, shuttleId, dispatcher) {
    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails || !taskDetails.endNodeQr || !taskDetails.endNodeFloorId) {
      logger.error(`[InboundHandler] Cannot find details for completed task ${taskId}.`);
      if (dispatcher) {
        setTimeout(() => dispatcher.dispatchNextTask(), 1000);
      }
      await PathCacheService.deletePath(shuttleId);
      return;
    }

    const endNodeCell = await cellService.getCellByQrCode(taskDetails.endNodeQr, taskDetails.endNodeFloorId);
    if (endNodeCell) {
      const palletId =
        typeof taskDetails.itemInfo === 'object'
          ? taskDetails.itemInfo.id || JSON.stringify(taskDetails.itemInfo)
          : taskDetails.itemInfo;

      await cellService.updateCellHasBox(endNodeCell.id, true, palletId);

      const endNodeLockKey = `endnode:lock:${endNodeCell.id}`;
      await ReservationService.releaseLock(endNodeLockKey);
    } else {
      logger.error(
        `[InboundHandler] Cannot find endNode cell QR '${taskDetails.endNodeQr}' in DB. Cannot update is_has_box or release lock.`,
      );
    }

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'completed');

    // Batch completion logic
    const batchId = taskDetails.batchId;
    const targetRow = taskDetails.targetRow;
    const targetFloor = taskDetails.targetFloor;

    if (batchId && targetRow !== undefined && targetFloor !== undefined) {
      try {
        const itemId =
          typeof taskDetails.itemInfo === 'object'
            ? taskDetails.itemInfo.ID || taskDetails.itemInfo.id || JSON.stringify(taskDetails.itemInfo)
            : taskDetails.itemInfo;

        await CellRepository.updateNodeStatus(taskDetails.endNodeQr, { item_ID: itemId });

        const totalProcessedKey = `batch:${batchId}:processed_items`;
        const currentTotalProcessed = await redisClient.incr(totalProcessedKey);

        const counterKey = `batch:${batchId}:row_counter`;
        const remainingInRow = await redisClient.decr(counterKey);

        if (remainingInRow <= 0) {
          const masterBatchKey = `batch:master:${batchId}`;
          const masterBatchData = await redisClient.get(masterBatchKey);

          if (masterBatchData) {
            const batch = JSON.parse(masterBatchData);

            batch.processedItems = parseInt(currentTotalProcessed, 10);
            batch.currentRow = null;
            batch.status = 'pending';

            await redisClient.set(masterBatchKey, JSON.stringify(batch), { EX: 3600 });

            await RowDirectionManager.clearRowDirectionLock(targetRow, targetFloor);

            await controller.processBatchRow(batchId);
          } else {
            logger.warn(`[InboundHandler] Master batch ${batchId} not found in Redis`);
          }

          await redisClient.del(counterKey);
        }
      } catch (rowError) {
        logger.error(`[InboundHandler] Error in row completion detection for batch ${batchId}:`, rowError);
      }
    }

    // Release row direction lock
    if (targetRow !== undefined && targetFloor !== undefined) {
      try {
        await RowDirectionManager.releaseShuttleFromRow(targetRow, targetFloor, shuttleId);
      } catch (releaseError) {
        logger.error(`[InboundHandler] Error releasing row direction lock for shuttle ${shuttleId}:`, releaseError);
      }
    }

    // Update shuttle counter
    try {
      await ShuttleCounterService.updateCounter();
    } catch (counterError) {
      logger.error(`[InboundHandler] Error updating shuttle counter:`, counterError);
    }

    // Keep node occupation
    logger.debug(`[InboundHandler] Shuttle ${shuttleId} remains at current node, keeping occupation`);

    // Force update shuttle status to IDLE (8)
    const currentState = (await getShuttleState(shuttleId)) || {};
    await updateShuttleState(shuttleId, {
      ...currentState,
      shuttleStatus: 8,
      packageStatus: 0,
      isCarrying: false,
      current_node: taskDetails.endNodeQr,
      qrCode: taskDetails.endNodeQr,
      taskId: '',
      targetQr: '',
      targetRow: '', // Clear targetRow
    });

    // Auto process inbound queue
    setTimeout(async () => {
      const result = await controller.autoProcessInboundQueue(shuttleId);
      if (!result.success) {
        logger.debug(
          `[InboundHandler] autoProcessInboundQueue failed (${result.reason}), falling back to dispatchNextTask`,
        );
        if (dispatcher) {
          dispatcher.dispatchNextTask();
        }
      } else {
        logger.info(`[InboundHandler] Shuttle ${shuttleId} automatically picked up next task from queue`);
      }
    }, 1000);

    await PathCacheService.deletePath(shuttleId);
  }
}

module.exports = new InboundTaskHandler();
