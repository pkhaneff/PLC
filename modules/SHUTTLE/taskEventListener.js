const mqtt = require('mqtt');
const mqttService = require('../../services/mqttService');
const { logger } = require('../../logger/logger');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const cellService = require('../SHUTTLE/cellService');
const { findShortestPath } = require('./pathfinding');
const { updateShuttleState } = require('./shuttleStateCache');
const ReservationService = require('../COMMON/reservationService');
const ConflictResolutionService = require('./ConflictResolutionService');
const NodeOccupationService = require('./NodeOccupationService');

const PathCacheService = require('./PathCacheService'); // Import PathCacheService

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
    logger.info('[TaskEventListener] Dispatcher has been set.');
  }

  initialize() {
    if (!this.client) {
      logger.error('[TaskEventListener] MQTT client not available.');
      return;
    }

    // Ensure we only subscribe and set up message handling AFTER a successful connection.
    this.client.on('connect', () => {
      logger.info('[TaskEventListener] MQTT client connected successfully.');

      this.client.subscribe(this.EVENTS_TOPIC, (err) => {
        if (err) {
          logger.error(`[TaskEventListener] Failed to subscribe to topic: ${this.EVENTS_TOPIC}`, err);
        } else {
          logger.info(`[TaskEventListener] Subscribed to topic: ${this.EVENTS_TOPIC}`);
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
        logger.warn(`[TaskEventListener] Received event with missing event type. Payload: ${message.toString()}`);
        return;
      }
      // For PICKUP_COMPLETE and TASK_COMPLETE, taskId is crucial
      if ((event === 'PICKUP_COMPLETE' || event === 'TASK_COMPLETE') && !taskId) {
        logger.warn(`[TaskEventListener] Received critical event '${event}' with missing taskId. Payload: ${message.toString()}`);
        return;
      }

      logger.info(`[TaskEventListener] Received event '${event}' for task ${taskId || 'N/A'} from shuttle ${shuttleId}`);

      switch (event) {
        case 'shuttle-task-started':
          if (taskId) {
            // Update task status to in_progress as soon as shuttle starts moving
            await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
            logger.info(`[TaskEventListener] Task ${taskId} status updated to 'in_progress' due to shuttle-task-started event.`);
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
          logger.info(`[TaskEventListener] Shuttle ${shuttleId} is waiting, triggering conflict resolution`);
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

      // Block initial node where shuttle starts
      await NodeOccupationService.blockNode(initialNode, shuttleId);
      const nodeName = await cellService.getDisplayNameWithoutFloor(initialNode);
      logger.info(`[TaskEventListener] Shuttle ${shuttleId} initialized at ${nodeName}, node blocked`);

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

      // Update node occupation: block new node, unblock old node
      await NodeOccupationService.handleShuttleMove(shuttleId, previousNode, currentNode);

      // --- 2-Stage Sequential Lock Release Logic ---
      // CRITICAL: Lock is ONLY released when BOTH conditions are met IN ORDER:
      // 1. PICKUP_COMPLETE must happen FIRST (pickupCompleted flag set)
      // 2. THEN shuttle passes safetyNodeExit WHILE carrying cargo
      const taskInfo = await shuttleTaskQueueService.getShuttleTask(shuttleId);

      if (!taskInfo) {
        return; // No active task
      }

      // Check if shuttle reached safety exit node
      const shuttleConfig = require('../../config/shuttle.config');
      const configEntry = Object.entries(shuttleConfig.warehouses).find(
        ([, config]) => config.pickupNodeQr === taskInfo.pickupNodeQr
      );

      if (!configEntry) {
        return; // No matching config
      }

      const config = configEntry[1];

      // DEBUG: Log every node shuttle passes to verify QR codes
      logger.info(`[TaskEventListener] 🔍 DEBUG: Shuttle ${shuttleId} at QR: ${currentNode}, looking for safetyNodeExit: ${config.safetyNodeExit}, match: ${currentNode === config.safetyNodeExit}`);

      if (currentNode === config.safetyNodeExit) {
        // Shuttle is at safety exit node
        // CHECK BOTH CONDITIONS:

        // 1. Check if pickup was completed (flag in task)
        const redisClient = require('../../redis/init.redis');
        const taskKey = shuttleTaskQueueService.getTaskKey(taskInfo.taskId);
        const pickupCompleted = await redisClient.hGet(taskKey, 'pickupCompleted');

        if (pickupCompleted !== 'true') {
          // Pickup NOT completed yet - shuttle is going TO pickup, not FROM pickup
          logger.debug(`[TaskEventListener] Shuttle ${shuttleId} at safety exit but pickup not completed. Going TO pickup, not releasing lock.`);
          return;
        }

        // 2. Check if shuttle is carrying cargo
        const { getShuttleState } = require('./shuttleStateCache');
        const shuttleState = await getShuttleState(shuttleId);

        if (!shuttleState || !shuttleState.isCarrying) {
          // Not carrying cargo - should not happen if pickupCompleted is true, but check anyway
          logger.warn(`[TaskEventListener] Shuttle ${shuttleId} at safety exit with pickupCompleted=true but not carrying cargo!`);
          return;
        }

        // BOTH conditions met IN ORDER: pickup completed + at exit + carrying cargo
        const safetyNodeName = await cellService.getDisplayNameWithoutFloor(currentNode);
        const pickupName = await cellService.getCachedDisplayName(taskInfo.pickupNodeQr, taskInfo.pickupNodeFloorId);
        logger.info(`[TaskEventListener] ✅ Shuttle ${shuttleId} passed Safety Exit Node ${safetyNodeName} with cargo AFTER pickup. Releasing Pickup Lock for ${pickupName}.`);

        const pickupLockKey = `pickup:lock:${config.pickupNodeQr}`;
        await ReservationService.releaseLock(pickupLockKey);

        // Clear the pickupCompleted flag to prevent double release
        await redisClient.hDel(taskKey, 'pickupCompleted');

        // Idea 1: Proactively trigger dispatcher after lock release
        if (this.dispatcher) {
            logger.info(`[TaskEventListener] Proactively triggering next dispatch cycle after pickup lock release.`);
            setTimeout(() => this.dispatcher.dispatchNextTask(), 1000); // 1-second delay
        }
      }
      // --- End 2-Stage Sequential Logic ---

    } catch (error) {
      logger.error(`[TaskEventListener] Error handling shuttle-moved for ${shuttleId}:`, error);
    }
  }

  async handlePickupComplete(taskId, shuttleId) {
    logger.info(`[TaskEventListener] >>> handlePickupComplete called for task ${taskId}, shuttle ${shuttleId}`);

    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails) {
      logger.error(`[TaskEventListener] Cannot find details for task ${taskId} after pickup.`);
      return;
    }

    const { pickupNodeQr, pickupNodeFloorId, endNodeQr, endNodeFloorId } = taskDetails;
    // Enrich logs with cell names
    const pickupName = await cellService.getCachedDisplayName(pickupNodeQr, pickupNodeFloorId);
    const endName = await cellService.getCachedDisplayName(endNodeQr, endNodeFloorId);
    logger.info(`[TaskEventListener] Task ${taskId} details - pickup: ${pickupName}, end: ${endName}`);

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');

    // --- Set pickupCompleted flag (Stage 1 of 2-stage lock release) ---
    // This flag indicates pickup is complete. Lock will be released when shuttle
    // passes safetyNodeExit (Stage 2) in handleShuttleMoved.
    const redisClient = require('../../redis/init.redis');
    const taskKey = shuttleTaskQueueService.getTaskKey(taskId);
    await redisClient.hSet(taskKey, 'pickupCompleted', 'true');
    logger.info(`[TaskEventListener] 🏁 Stage 1 complete: Shuttle ${shuttleId} completed pickup at ${pickupName}. Waiting for Stage 2 (pass safetyNodeExit).`);
    // --- End Stage 1 ---

    // Verify pickup node still exists? (Optional, skipping for speed)

    // Dynamic Obstacle Avoidance for Path 2 (Soft Avoidance)
    const occupiedMap = await NodeOccupationService.getAllOccupiedNodes();
    const avoidNodes = Object.keys(occupiedMap).filter(qr =>
      qr !== pickupNodeQr && // Don't avoid start
      qr !== endNodeQr       // Don't avoid destination
    );
    logger.info(`[TaskEventListener] Planning Path 2 (Pickup->End) avoiding ${avoidNodes.length} obstacles.`);

    // Get all active paths from PathCacheService for traffic awareness
    const trafficData = await PathCacheService.getAllActivePaths();
    logger.debug(`[TaskEventListener] Traffic data for pathfinding: ${JSON.stringify(trafficData.map(t => t.shuttleId))}`);

    // 1. Try to find path avoiding obstacles with DROP_OFF action at destination
    const { TASK_ACTIONS } = require('../../config/shuttle.config');
    let path2 = await findShortestPath(
      pickupNodeQr,
      endNodeQr,
      endNodeFloorId,
      {
        avoid: avoidNodes,
        isCarrying: true, // Shuttle is now carrying cargo
        trafficData: trafficData, // Pass traffic data for proactive avoidance
        lastStepAction: TASK_ACTIONS.DROP_OFF
      }
    );

    // 2. Fallback: If no path found avoiding obstacles, try direct path (ConflictResolution will handle yielding)
    if (!path2) {
      logger.warn(`[TaskEventListener] Soft avoidance failed for Path 2. Trying direct path (relying on Priority/Yield).`);
      // Pass avoid: [] to EXPLICITLY disable auto-injection of dynamic obstacles in the fallback
      path2 = await findShortestPath(
        pickupNodeQr,
        endNodeQr,
        endNodeFloorId,
        {
          avoid: [],
          isCarrying: true, // Still carrying on fallback
          trafficData: trafficData, // Pass traffic data for proactive avoidance
          lastStepAction: TASK_ACTIONS.DROP_OFF
        }
      );
    }

    if (!path2) {
      logger.error(`[TaskEventListener] Failed to find Path 2 for task ${taskId}. Marking as failed.`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
      return;
    }

    // Ensure path has steps before saving
    if (!path2 || !path2.totalStep || path2.totalStep === 0) {
      logger.error(`[TaskEventListener] Path calculated for task ${taskId} has no steps.`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
      return;
    }

    // Save the path to PathCacheService (Trụ cột 1)
    await PathCacheService.savePath(shuttleId, path2);
    logger.info(`[TaskEventListener] Path for shuttle ${shuttleId} (task ${taskId}) saved to PathCacheService.`);

    // UPDATE STATE: Mark task and shuttle as carrying cargo so Priority Service works
    await redisClient.hSet(taskKey, 'isCarrying', 'true'); // Update Redis Task

    // CRITICAL FIX: getShuttleState() is now async (reads from Redis)
    const { getShuttleState } = require('./shuttleStateCache');
    const currentShuttleState = await getShuttleState(shuttleId) || {};
    await updateShuttleState(shuttleId, { ...currentShuttleState, isCarrying: true, packageStatus: 1 });
    logger.info(`[TaskEventListener] Updated Task ${taskId} and Shuttle ${shuttleId} state to isCarrying=true`);

    // Send mission using new format with retry mechanism
    const { MQTT_TOPICS } = require('../../config/shuttle.config');
    const pathSteps = path2.steps || path2;
    const missionTopic = `${MQTT_TOPICS.SEND_MISSION}/${shuttleId}`;

    const missionPayload = {
      ...pathSteps,
      meta: {
        taskId: taskId,
        onArrival: 'TASK_COMPLETE',
        step: 'move_to_end',
        pickupNodeQr: pickupNodeQr,
        endNodeQr: endNodeQr,
        itemInfo: taskDetails.itemInfo
      }
    };

    // Use dispatcher's retry mechanism if available
    if (this.dispatcher && this.dispatcher.publishMissionWithRetry) {
      await this.dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
    } else {
      // Fallback to direct publish
      mqttService.publishToTopic(missionTopic, missionPayload);
    }

    logger.info(`[TaskEventListener] Sent Path 2 mission to shuttle ${shuttleId} for task ${taskId}. Route: ${pickupName} -> ${endName} (${pathSteps.totalStep} steps)`);
  }

  async handleTaskComplete(taskId, shuttleId) {
    const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
    if (!taskDetails || !taskDetails.endNodeQr || !taskDetails.endNodeFloorId) {
      logger.error(`[TaskEventListener] Cannot find details for completed task ${taskId}.`);
      // Even if task details are missing, we still try to trigger the next dispatch
      if (this.dispatcher) {
        logger.info(`[TaskEventListener] Proactively triggering next dispatch cycle due to task completion/failure.`);
        setTimeout(() => this.dispatcher.dispatchNextTask(), 1000); // 1-second delay
      }
      // CRITICAL: Delete path even if task details are missing to clean up
      await PathCacheService.deletePath(shuttleId);
      logger.info(`[TaskEventListener] Path for shuttle ${shuttleId} (task ${taskId}) deleted from PathCacheService due to task complete (details missing).`);
      return;
    }

    // Lookup cell by QR to get ID
    const endNodeCell = await cellService.getCellByQrCode(taskDetails.endNodeQr, taskDetails.endNodeFloorId);
    if (endNodeCell) {
      // 1. Update DB: Mark cell as having a box and store pallet ID
      // Assuming itemInfo is the pallet ID or contains it. If it's a simple string, use it directly.
      const palletId = typeof taskDetails.itemInfo === 'object' ? taskDetails.itemInfo.id || JSON.stringify(taskDetails.itemInfo) : taskDetails.itemInfo;

      await cellService.updateCellHasBox(endNodeCell.id, true, palletId);
      logger.info(`[TaskEventListener] DB updated: Cell ${endNodeCell.id} marked as is_has_box = 1 with pallet_id = ${palletId}.`);

      // 2. Release Redis Lock for the endNode
      // Note: Lock key uses ID, so we needed the lookup
      const endNodeLockKey = `endnode:lock:${endNodeCell.id}`;
      await ReservationService.releaseLock(endNodeLockKey);

    } else {
      logger.error(`[TaskEventListener] Cannot find endNode cell QR '${taskDetails.endNodeQr}' in DB. Cannot update is_has_box or release lock.`);
    }

    // 4. Final step: update task status to completed
    await shuttleTaskQueueService.updateTaskStatus(taskId, 'completed');
    const endNodeName = await cellService.getCachedDisplayName(taskDetails.endNodeQr, taskDetails.endNodeFloorId);
    logger.info(`[TaskEventListener] Task ${taskId} successfully completed by shuttle ${shuttleId} at ${endNodeName}.`);

    // 5. Keep node occupation - shuttle is still physically at this node
    // The node will be unblocked automatically when shuttle moves to next task
    logger.debug(`[TaskEventListener] Shuttle ${shuttleId} remains at current node, keeping occupation`);

    // 6. Force update shuttle status to IDLE (8) in Redis so Dispatcher can pick it up immediately
    // CRITICAL FIX: getShuttleState() is now async (reads from Redis)
    const { getShuttleState } = require('./shuttleStateCache');
    const currentState = await getShuttleState(shuttleId) || {};
    await updateShuttleState(shuttleId, {
      ...currentState,
      shuttleStatus: 8, // Force IDLE
      packageStatus: 0, // No longer carrying
      isCarrying: false,
      current_node: taskDetails.endNodeQr, // Update current node to end node QR
      qrCode: taskDetails.endNodeQr     // Ensure consistency
    });
    logger.info(`[TaskEventListener] Force updated shuttle ${shuttleId} status to IDLE (8) in Redis.`);

    // 7. Proactively trigger the next dispatch cycle after a short delay
    if (this.dispatcher) {
      logger.info(`[TaskEventListener] Proactively triggering next dispatch cycle in 1 second.`);
      setTimeout(() => this.dispatcher.dispatchNextTask(), 1000);
    }

    // Delete path from PathCacheService (Trụ cột 1)
    await PathCacheService.deletePath(shuttleId);
    logger.info(`[TaskEventListener] Path for shuttle ${shuttleId} (task ${taskId}) deleted from PathCacheService.`);
  }
}

// Export a single instance
module.exports = new TaskEventListener();