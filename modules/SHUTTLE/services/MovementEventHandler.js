const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');
const cellService = require('./cellService');
const { updateShuttleState, getShuttleState } = require('./shuttleStateCache');
const NodeOccupationService = require('./NodeOccupationService');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const ReservationService = require('../../COMMON/reservationService');
const { warehouses } = require('../../../config/shuttle.config');

class MovementEventHandler {
  async handleShuttleInitialized(shuttleId, eventPayload) {
    try {
      const { initialNode } = eventPayload;

      if (!initialNode) {
        logger.warn(`[MovementHandler] shuttle-initialized event missing initialNode for shuttle ${shuttleId}`);
        return;
      }

      const currentState = (await getShuttleState(shuttleId)) || {};
      await updateShuttleState(shuttleId, {
        ...currentState,
        currentNode: initialNode,
        qrCode: initialNode,
      });

      // Block initial node where shuttle starts
      await NodeOccupationService.blockNode(initialNode, shuttleId);
      await cellService.getDisplayNameWithoutFloor(initialNode);
    } catch (error) {
      logger.error(`[MovementHandler] Error handling shuttle-initialized for ${shuttleId}:`, error);
    }
  }

  async handleShuttleMoved(shuttleId, eventPayload, dispatcher) {
    try {
      const { currentNode, previousNode } = eventPayload;

      if (!currentNode) {
        logger.warn(`[MovementHandler] shuttle-moved event missing currentNode for shuttle ${shuttleId}`);
        return;
      }

      const currentState = (await getShuttleState(shuttleId)) || {};
      await updateShuttleState(shuttleId, {
        ...currentState,
        currentNode: currentNode,
        qrCode: currentNode,
      });
      logger.debug(`[MovementHandler] Updated shuttle ${shuttleId} position to ${currentNode}`);

      // Update node occupation: block new node, unblock old node
      await NodeOccupationService.handleShuttleMove(shuttleId, previousNode, currentNode);

      // 2. THEN shuttle passes safetyNodeExit WHILE carrying cargo
      const taskInfo = await shuttleTaskQueueService.getShuttleTask(shuttleId);

      if (!taskInfo) {
        return; // No active task
      }

      // Check if shuttle reached safety exit node
      const configEntry = Object.entries(warehouses).find(
        ([, config]) => config.pickupNodeQr === taskInfo.pickupNodeQr,
      );

      if (!configEntry) {
        return; // No matching config
      }

      const config = configEntry[1];

      if (currentNode === config.safetyNodeExit) {
        // 1. Check if pickup was completed (flag in task)
        const taskKey = shuttleTaskQueueService.getTaskKey(taskInfo.taskId);
        const pickupCompleted = await redisClient.hGet(taskKey, 'pickupCompleted');

        if (pickupCompleted !== 'true') {
          // Pickup NOT completed yet - shuttle is going TO pickup, not FROM pickup
          logger.debug(
            `[MovementHandler] Shuttle ${shuttleId} at safety exit but pickup not completed. Going TO pickup, not releasing lock.`,
          );
          return;
        }

        // 2. Check if shuttle is carrying cargo
        const shuttleState = await getShuttleState(shuttleId);

        if (!shuttleState || !shuttleState.isCarrying) {
          // Not carrying cargo - should not happen if pickupCompleted is true, but check anyway
          logger.warn(
            `[MovementHandler] Shuttle ${shuttleId} at safety exit with pickupCompleted=true but not carrying cargo!`,
          );
          return;
        }

        // BOTH conditions met IN ORDER: pickup completed + at exit + carrying cargo
        await cellService.getDisplayNameWithoutFloor(currentNode);
        await cellService.getCachedDisplayName(taskInfo.pickupNodeQr, taskInfo.pickupNodeFloorId);

        const pickupLockKey = `pickup:lock:${config.pickupNodeQr}`;
        await ReservationService.releaseLock(pickupLockKey);

        // Clear the pickupCompleted flag to prevent double release
        await redisClient.hDel(taskKey, 'pickupCompleted');

        // Idea 1: Proactively trigger dispatcher after lock release
        if (dispatcher) {
          setTimeout(() => dispatcher.dispatchNextTask(), 1000); // 1-second delay
        }
      }
      // --- End 2-Stage Sequential Logic ---
    } catch (error) {
      logger.error(`[MovementHandler] Error handling shuttle-moved for ${shuttleId}:`, error);
    }
  }
}

module.exports = new MovementEventHandler();
