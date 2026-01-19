const mqtt = require('mqtt');
const mqttService = require('../../services/mqttService');
const { logger } = require('../../logger/logger');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const cellService = require('../SHUTTLE/cellService');
const { findShortestPath } = require('./pathfinding');
const { updateShuttleState, getShuttleState } = require('./shuttleStateCache');
const ReservationService = require('../COMMON/reservationService');
const ConflictResolutionService = require('./ConflictResolutionService');
const NodeOccupationService = require('./NodeOccupationService');
const ShuttleCounterService = require('./ShuttleCounterService');
const RowDirectionManager = require('./RowDirectionManager');
const RowCoordinationService = require('./RowCoordinationService');
const PathCacheService = require('./PathCacheService');
const { TASK_ACTIONS, MQTT_TOPICS, SHUTTLE_STATUS, warehouses } = require('../../config/shuttle.config');
const redisClient = require('../../redis/init.redis');
const CellRepository = require('../../repository/cell.repository');
const controller = require('../../controllers/shuttle.controller');

const MQTT_BROKER_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const SHUTTLE_IDLE_STATUS = 8; // Define constant for IDLE status

class TaskEventListener {
  constructor() {
    this.client = mqtt.connect(MQTT_BROKER_URL, {
      clientId: `task_event_listener_${Date.now()}`
    });
    this.EVENTS_TOPIC = 'shuttle/events';
    this.dispatcher = null; // To hold the dispatcher instance
  }

  /**
   * Sets the dispatcher instance to allow event-driven calls.
   * @param {ShuttleDispatcherService} dispatcher - The dispatcher instance.
   */
  setDispatcher(dispatcher) {
    this.dispatcher = dispatcher;
  }

  initialize() {
    if (!this.client) {
      logger.error('[TaskEventListener] MQTT client not available.');
      return;
    }

    // Ensure we only subscribe and set up message handling AFTER a successful connection.
    this.client.on('connect', () => {

      this.client.subscribe(this.EVENTS_TOPIC, (err) => {
        if (err) {
          logger.error(`[TaskEventListener] Failed to subscribe to topic: ${this.EVENTS_TOPIC}`, err);
        } else {
        }
      });
    });

    this.client.on('message', (topic, message) => {
      if (topic === this.EVENTS_TOPIC) {
        this.handleEvent(message);
      }
    });

    this.client.on('error', (err) => {
      logger.error('[TaskEventListener] MQTT client connection error:', err);
    });
  }

  async handleEvent(message) {
    try {
      if (!message || message.length === 0) {
        logger.debug('[TaskEventListener] Received an empty message. Ignoring.');
        return;
      }
      const eventPayload = JSON.parse(message.toString());
      let { event, taskId, shuttleId } = eventPayload;

      // Try to extract taskId from taskInfo if not at top level
      if (!taskId && eventPayload.taskInfo && eventPayload.taskInfo.taskId) {
        taskId = eventPayload.taskInfo.taskId;
      }

      // Only warn for missing critical fields on events that require them for core logic
      if (!event) {
        return;
      }
      // For PICKUP_COMPLETE and TASK_COMPLETE, taskId is crucial
      if ((event === 'PICKUP_COMPLETE' || event === 'TASK_COMPLETE') && !taskId) {
        return;
      }

      switch (event) {
        case 'shuttle-task-started':
          if (taskId) {
            // Update task status to in_progress as soon as shuttle starts moving
            await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
          }
          break;

        case 'PICKUP_COMPLETE':
          if (taskId) { // taskId is guaranteed to be present by checks above
            await this.handlePickupComplete(taskId, shuttleId);
          }
          break;

        case 'TASK_COMPLETE':
          if (taskId) { // taskId is guaranteed to be present by checks above
            await this.handleTaskComplete(taskId, shuttleId);
          }
          break;

        case 'shuttle-waiting':
          // Handle conflict resolution
          await ConflictResolutionService.handleConflict(shuttleId, eventPayload);
          break;

        case 'shuttle-moved':
          // Handle node occupation: block new node, unblock old node
          await this.handleShuttleMoved(shuttleId, eventPayload);
          break;

        case 'shuttle-initialized':
          // Handle initial node occupation when shuttle starts
          await this.handleShuttleInitialized(shuttleId, eventPayload);
          break;

        default:
          // Other informational events (shuttle-resumed, etc.) can be debugged
          logger.debug(`[TaskEventListener] Ignoring informational event type: ${event}. Payload: ${message.toString()}`);
          break;
      }
    } catch (error) {
      logger.error(`[TaskEventListener] Error handling event. Payload: ${message.toString()}`, error);
    }
  }

  async handleShuttleInitialized(shuttleId, eventPayload) {
    try {
      const { initialNode } = eventPayload;

      if (!initialNode) {
        logger.warn(`[TaskEventListener] shuttle-initialized event missing initialNode for shuttle ${shuttleId}`);
        return;
      }

      const currentState = await getShuttleState(shuttleId) || {};
      await updateShuttleState(shuttleId, {
        ...currentState,
        current_node: initialNode,
        qrCode: initialNode
      });

      // Block initial node where shuttle starts
      await NodeOccupationService.blockNode(initialNode, shuttleId);
      const nodeName = await cellService.getDisplayNameWithoutFloor(initialNode);

    } catch (error) {
      logger.error(`[TaskEventListener] Error handling shuttle-initialized for ${shuttleId}:`, error);
    }
  }

  async handleShuttleMoved(shuttleId, eventPayload) {
    try {
      const { currentNode, previousNode } = eventPayload;

      if (!currentNode) {
        logger.warn(`[TaskEventListener] shuttle-moved event missing currentNode for shuttle ${shuttleId}`);
        return;
      }

      const currentState = await getShuttleState(shuttleId) || {};
      await updateShuttleState(shuttleId, {
        ...currentState,
        current_node: currentNode,
        qrCode: currentNode
      });
      logger.debug(`[TaskEventListener] Updated shuttle ${shuttleId} position to ${currentNode}`);

      // Update node occupation: block new node, unblock old node
      await NodeOccupationService.handleShuttleMove(shuttleId, previousNode, currentNode);

      // 2. THEN shuttle passes safetyNodeExit WHILE carrying cargo
      const taskInfo = await shuttleTaskQueueService.getShuttleTask(shuttleId);

      if (!taskInfo) {
        return; // No active task
      }

      // Check if shuttle reached safety exit node
      const configEntry = Object.entries(warehouses).find(
        ([, config]) => config.pickupNodeQr === taskInfo.pickupNodeQr
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
          logger.debug(`[TaskEventListener] Shuttle ${shuttleId} at safety exit but pickup not completed. Going TO pickup, not releasing lock.`);
          return;
        }

        // 2. Check if shuttle is carrying cargo
        const shuttleState = await getShuttleState(shuttleId);

        if (!shuttleState || !shuttleState.isCarrying) {
          // Not carrying cargo - should not happen if pickupCompleted is true, but check anyway
          logger.warn(`[TaskEventListener] Shuttle ${shuttleId} at safety exit with pickupCompleted=true but not carrying cargo!`);
          return;
        }

        // BOTH conditions met IN ORDER: pickup completed + at exit + carrying cargo
        const safetyNodeName = await cellService.getDisplayNameWithoutFloor(currentNode);
        const pickupName = await cellService.getCachedDisplayName(taskInfo.pickupNodeQr, taskInfo.pickupNodeFloorId);

        const pickupLockKey = `pickup:lock:${config.pickupNodeQr}`;
        await ReservationService.releaseLock(pickupLockKey);

        // Clear the pickupCompleted flag to prevent double release
        await redisClient.hDel(taskKey, 'pickupCompleted');

        // Idea 1: Proactively trigger dispatcher after lock release
        if (this.dispatcher) {
          setTimeout(() => this.dispatcher.dispatchNextTask(), 1000); // 1-second delay
        }
      }
      // --- End 2-Stage Sequential Logic ---

    } catch (error) {
      logger.error(`[TaskEventListener] Error handling shuttle-moved for ${shuttleId}:`, error);
    }
  }

  async handlePickupComplete(taskId, shuttleId) {

    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails) {
      logger.error(`[TaskEventListener] Cannot find details for task ${taskId} after pickup.`);
      return;
    }

    const { pickupNodeQr, pickupNodeFloorId, endNodeQr, endNodeFloorId } = taskDetails;
    const pickupName = await cellService.getCachedDisplayName(pickupNodeQr, pickupNodeFloorId);
    const endName = await cellService.getCachedDisplayName(endNodeQr, endNodeFloorId);

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');

    const taskKey = shuttleTaskQueueService.getTaskKey(taskId);
    await redisClient.hSet(taskKey, 'pickupCompleted', 'true');

    const occupiedMap = await NodeOccupationService.getAllOccupiedNodes();
    const avoidNodes = Object.keys(occupiedMap).filter(qr =>
      qr !== pickupNodeQr &&
      qr !== endNodeQr
    );

    const trafficData = await PathCacheService.getAllActivePaths();
    logger.debug(`[TaskEventListener] Traffic data for pathfinding: ${JSON.stringify(trafficData.map(t => t.shuttleId))}`);

    const activeShuttleCount = await ShuttleCounterService.updateCounter();
    let enforceOneWay = activeShuttleCount >= 2;

    if (taskDetails.batchId) {
      enforceOneWay = true;
    }

    let targetRow = null;
    let actualEndNodeQr = endNodeQr;

    if (enforceOneWay) {
      const batchId = taskDetails.batchId;

      if (batchId) {
        targetRow = await RowCoordinationService.assignRowForBatch(batchId, endNodeQr, endNodeFloorId);

        if (!targetRow) {
          logger.error(`[TaskEventListener] Cannot assign row for batch ${batchId}. Marking task as failed.`);
          await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
          return;
        }

        const isEndNodeInRow = await RowCoordinationService.isNodeInAssignedRow(endNodeQr, endNodeFloorId, targetRow);

        if (!isEndNodeInRow) {
          logger.warn(`[TaskEventListener] EndNode ${endName} không nằm trong assigned row ${targetRow}. Tìm node thay thế...`);

          const nearestNode = await RowCoordinationService.findNearestNodeInRow(pickupNodeQr, targetRow, endNodeFloorId);

          if (!nearestNode) {
            logger.error(`[TaskEventListener] Cannot find available node in assigned row ${targetRow}. Marking task as failed.`);
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
        try {
          const pickupCell = await cellService.getCellByQrCode(pickupNodeQr, endNodeFloorId);
          const endCell = await cellService.getCellByQrCode(actualEndNodeQr, endNodeFloorId);

          if (pickupCell && endCell) {
            if (endCell.col < pickupCell.col) {
              requiredDirection = 2; // RIGHT_TO_LEFT
            } else {
              requiredDirection = 1; // LEFT_TO_RIGHT
            }
          } else {
            requiredDirection = 1;
          }
        } catch (e) {
          requiredDirection = 1;
        }
      } else {
      }

      const locked = await RowDirectionManager.lockRowDirection(
        targetRow,
        endNodeFloorId,
        requiredDirection,
        shuttleId
      );

      if (!locked) {
        logger.error(`[TaskEventListener] Cannot lock row ${targetRow} for shuttle ${shuttleId}. Row has opposite traffic direction. Marking task as failed.`);
        await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
        return;
      }
    }

    let path2 = await findShortestPath(
      pickupNodeQr,
      actualEndNodeQr,
      endNodeFloorId,
      {
        avoid: avoidNodes,
        isCarrying: true,
        trafficData: trafficData,
        lastStepAction: TASK_ACTIONS.DROP_OFF,
        enforceOneWay: enforceOneWay,
        targetRow: targetRow,
        requiredDirection: requiredDirection
      }
    );

    if (!path2) {
      logger.warn(`[TaskEventListener] Soft avoidance failed for Path 2. Trying direct path (relying on Priority/Yield).`);
      path2 = await findShortestPath(
        pickupNodeQr,
        actualEndNodeQr,
        endNodeFloorId,
        {
          avoid: [],
          isCarrying: true,
          trafficData: trafficData,
          lastStepAction: TASK_ACTIONS.DROP_OFF,
          enforceOneWay: enforceOneWay,
          targetRow: targetRow,
          requiredDirection: requiredDirection
        }
      );
    }

    if (!path2) {
      logger.error(`[TaskEventListener] Failed to find Path 2 for task ${taskId}. Marking as failed.`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
      return;
    }

    if (!path2 || !path2.totalStep || path2.totalStep === 0) {
      logger.error(`[TaskEventListener] Path calculated for task ${taskId} has no steps.`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
      return;
    }

    await PathCacheService.savePath(shuttleId, path2);

    await redisClient.hSet(taskKey, 'isCarrying', 'true');

    const currentShuttleState = await getShuttleState(shuttleId) || {};
    await updateShuttleState(shuttleId, { ...currentShuttleState, isCarrying: true, packageStatus: 1 });

    const pathSteps = path2.steps || path2;
    const missionTopic = `${MQTT_TOPICS.SEND_MISSION}/${shuttleId}`;

    const missionPayload = {
      ...pathSteps,
      meta: {
        taskId: taskId,
        onArrival: 'TASK_COMPLETE',
        step: 'move_to_end',
        pickupNodeQr: pickupNodeQr,
        endNodeQr: actualEndNodeQr,
        itemInfo: taskDetails.itemInfo
      }
    };

    if (this.dispatcher && this.dispatcher.publishMissionWithRetry) {
      await this.dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
    } else {
      mqttService.publishToTopic(missionTopic, missionPayload);
    }
  }

  async handleTaskComplete(taskId, shuttleId) {
    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails || !taskDetails.endNodeQr || !taskDetails.endNodeFloorId) {
      logger.error(`[TaskEventListener] Cannot find details for completed task ${taskId}.`);
      if (this.dispatcher) {
        setTimeout(() => this.dispatcher.dispatchNextTask(), 1000);
      }
      await PathCacheService.deletePath(shuttleId);
      return;
    }

    const endNodeCell = await cellService.getCellByQrCode(taskDetails.endNodeQr, taskDetails.endNodeFloorId);
    if (endNodeCell) {
      const palletId = typeof taskDetails.itemInfo === 'object' ? taskDetails.itemInfo.id || JSON.stringify(taskDetails.itemInfo) : taskDetails.itemInfo;

      await cellService.updateCellHasBox(endNodeCell.id, true, palletId);

      const endNodeLockKey = `endnode:lock:${endNodeCell.id}`;
      await ReservationService.releaseLock(endNodeLockKey);

    } else {
      logger.error(`[TaskEventListener] Cannot find endNode cell QR '${taskDetails.endNodeQr}' in DB. Cannot update is_has_box or release lock.`);
    }

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'completed');
    const endNodeName = await cellService.getCachedDisplayName(taskDetails.endNodeQr, taskDetails.endNodeFloorId);

    const batchId = taskDetails.batchId;
    const targetRow = taskDetails.targetRow;
    const targetFloor = taskDetails.targetFloor;

    if (batchId && targetRow !== undefined && targetFloor !== undefined) {
      try {
        const itemId = typeof taskDetails.itemInfo === 'object'
          ? (taskDetails.itemInfo.ID || taskDetails.itemInfo.id || JSON.stringify(taskDetails.itemInfo))
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
            logger.warn(`[TaskEventListener] Master batch ${batchId} not found in Redis`);
          }

          await redisClient.del(counterKey);
        }

      } catch (rowError) {
        logger.error(`[TaskEventListener] Error in row completion detection for batch ${batchId}:`, rowError);
      }
    }

    // 4b. Release row direction lock for this shuttle
    if (targetRow !== undefined && targetFloor !== undefined) {
      try {
        await RowDirectionManager.releaseShuttleFromRow(targetRow, targetFloor, shuttleId);
      } catch (releaseError) {
        logger.error(`[TaskEventListener] Error releasing row direction lock for shuttle ${shuttleId}:`, releaseError);
      }
    }

    // 4c. Update shuttle counter
    try {
      await ShuttleCounterService.updateCounter();
    } catch (counterError) {
      logger.error(`[TaskEventListener] Error updating shuttle counter:`, counterError);
    }

    // 5. Keep node occupation - shuttle is still physically at this node
    logger.debug(`[TaskEventListener] Shuttle ${shuttleId} remains at current node, keeping occupation`);

    // 6. Force update shuttle status to IDLE (8) in Redis so Dispatcher can pick it up immediately
    const currentState = await getShuttleState(shuttleId) || {};
    await updateShuttleState(shuttleId, {
      ...currentState,
      shuttleStatus: 8,
      packageStatus: 0,
      isCarrying: false,
      current_node: taskDetails.endNodeQr,
      qrCode: taskDetails.endNodeQr,
      taskId: '',
      targetQr: ''
    });

    // 7. Proactively trigger the next dispatch cycle after a short delay
    if (this.dispatcher) {
      setTimeout(() => this.dispatcher.dispatchNextTask(), 1000);
    }

    await PathCacheService.deletePath(shuttleId);
  }
}

module.exports = new TaskEventListener();