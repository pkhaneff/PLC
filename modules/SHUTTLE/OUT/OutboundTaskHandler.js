const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');
const shuttleTaskQueueService = require('../services/shuttleTaskQueueService');
const cellService = require('../services/cellService');
const { updateShuttleState, getShuttleState } = require('../services/shuttleStateCache');
const MissionCoordinatorService = require('../services/MissionCoordinatorService');
const mqttClientService = require('../../../services/mqttClientService');
const PathCacheService = require('../services/PathCacheService');
const { MQTT_TOPICS } = require('../../../config/shuttle.config');

class OutboundTaskHandler {
  /**
   * Handle shutdown after shuttle picks up cargo from storage node (pickup complete).
   * @param {string} taskId - Task ID
   * @param {string} shuttleId - Shuttle ID
   * @param {object} dispatcher - Dispatcher instance
   */
  async handlePickupComplete(taskId, shuttleId, dispatcher) {
    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails) {
      logger.error(`[OutboundHandler] Cannot find details for task ${taskId} after pickup.`);
      return;
    }

    const { pickupNodeQr, pickupNodeFloorId, endNodeQr, endNodeFloorId } = taskDetails;
    const taskKey = shuttleTaskQueueService.getTaskKey(taskId);

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
    await redisClient.hSet(taskKey, 'pickupCompleted', 'true');

    // Update cell: Remove cargo from pickup node
    const pickupNodeCell = await cellService.getCellByQrCode(pickupNodeQr, pickupNodeFloorId);
    if (pickupNodeCell) {
      await cellService.updateCellHasBox(pickupNodeCell.id, false);
      logger.info(`[OutboundHandler] Updated pickup node ${pickupNodeQr}: isHasBox = 0, palletId = NULL`);
    } else {
      logger.error(
        `[OutboundHandler] Cannot find pickup node cell QR '${pickupNodeQr}' in DB. Cannot update isHasBox.`,
      );
    }

    try {
      // Calculate path to outNode (end node)
      const missionPayload = await MissionCoordinatorService.calculateNextSegment(
        shuttleId,
        endNodeQr,
        endNodeFloorId,
        {
          taskId: taskId,
          onArrival: 'TASK_COMPLETE',
          pickupNodeQr: pickupNodeQr,
          endNodeQr: endNodeQr,
          itemInfo: taskDetails.itemInfo,
          isCarrying: true,
          enforceOneWay: false, // Outbound does not need one-way logic
          ignoreBoxOnNodes: [pickupNodeQr], // Ignore the node just picked up
        },
      );

      // Update shuttle package state
      const currentShuttleState = (await getShuttleState(shuttleId)) || {};
      await updateShuttleState(shuttleId, { ...currentShuttleState, isCarrying: true, packageStatus: 1 });
      await redisClient.hSet(taskKey, 'isCarrying', 'true');

      // Send mission
      const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;
      if (dispatcher && dispatcher.publishMissionWithRetry) {
        await dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
      } else {
        await mqttClientService.publishToTopic(missionTopic, missionPayload);
      }

      logger.info(`[OutboundHandler] Sent mission to shuttle ${shuttleId} to move to outNode ${endNodeQr}`);
    } catch (error) {
      logger.error(`[OutboundHandler] Error in path calculation: ${error.message}`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
    }
  }

  /**
   * Handle task completion after shuttle drops off cargo at outNode.
   * @param {string} taskId - Task ID
   * @param {string} shuttleId - Shuttle ID
   * @param {object} dispatcher - Dispatcher instance
   */
  async handleTaskComplete(taskId, shuttleId, dispatcher) {
    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails || !taskDetails.endNodeQr || !taskDetails.endNodeFloorId) {
      logger.error(`[OutboundHandler] Cannot find details for completed task ${taskId}.`);
      if (dispatcher) {
        setTimeout(() => dispatcher.dispatchNextTask(), 1000);
      }
      await PathCacheService.deletePath(shuttleId);
      return;
    }

    // Update task status
    await shuttleTaskQueueService.updateTaskStatus(taskId, 'completed');

    logger.info(`[OutboundHandler] Task ${taskId} completed. Pallet delivered to outNode ${taskDetails.endNodeQr}`);

    // Update shuttle state to IDLE
    const currentState = (await getShuttleState(shuttleId)) || {};
    await updateShuttleState(shuttleId, {
      ...currentState,
      shuttleStatus: 8, // IDLE
      packageStatus: 0,
      isCarrying: false,
      currentNode: taskDetails.endNodeQr,
      qrCode: taskDetails.endNodeQr,
      taskId: '',
      targetQr: '',
    });

    logger.info(`[OutboundHandler] Shuttle ${shuttleId} returned to IDLE state`);

    // Auto process inbound queue if shuttle is in executing mode
    setTimeout(async () => {
      const controller = require('../../../controllers/shuttle.controller');
      const result = await controller.autoProcessInboundQueue(shuttleId);
      if (!result.success) {
        logger.debug(
          `[OutboundHandler] autoProcessInboundQueue failed (${result.reason}), falling back to dispatchNextTask`,
        );
        if (dispatcher) {
          dispatcher.dispatchNextTask();
        }
      } else {
        logger.info(`[OutboundHandler] Shuttle ${shuttleId} automatically picked up next task from queue`);
      }
    }, 1000);

    await PathCacheService.deletePath(shuttleId);
  }
}

module.exports = new OutboundTaskHandler();
