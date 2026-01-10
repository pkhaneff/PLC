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
      logger.info(`[TaskEventListener] Shuttle ${shuttleId} initialized at ${initialNode}, node blocked`);

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
    // Enrich logs
    const pickupName = await cellService.enrichLogWithNames(pickupNodeQr, pickupNodeFloorId);
    const endName = await cellService.enrichLogWithNames(endNodeQr, endNodeFloorId);
    logger.info(`[TaskEventListener] Task ${taskId} details - pickup: ${pickupName}, end: ${endName}`);

    // --- Pipelining Logic ---
    // Release the lock on the pickupNode so the next shuttle can be dispatched to it.
    // Use pickupNodeQr for lock key
    const pickupLockKey = `pickup:lock:${pickupNodeQr}`;
    await ReservationService.releaseLock(pickupLockKey);
    // --- End Pipelining Logic ---

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');

    // Verify pickup node still exists? (Optional, skipping for speed)

    // Path 2: Pickup -> End (QR to QR)
    const path2 = await findShortestPath(pickupNodeQr, endNodeQr, endNodeFloorId);
    if (!path2) {
      logger.error(`[TaskEventListener] Failed to find Path 2 for task ${taskId}. Marking as failed.`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
      return;
    }

    const commandPayload = {
      path: path2.steps || path2, // Adjust depending on return format of findShortestPath
      taskInfo: taskDetails,
      onArrival: 'TASK_COMPLETE',
    };
    const commandTopic = `shuttle/command/${shuttleId}`;
    mqttService.publishToTopic(commandTopic, commandPayload);
    logger.info(`[TaskEventListener] Sent Path 2 command to shuttle ${shuttleId} for task ${taskId}.`);
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
      return;
    }

    // Lookup cell by QR to get ID
    const endNodeCell = await cellService.getCellByQrCode(taskDetails.endNodeQr, taskDetails.endNodeFloorId);
    if (endNodeCell) {
      // 1. Update DB: Mark cell as having a box
      await cellService.updateCellHasBox(endNodeCell.id, true);
      logger.info(`[TaskEventListener] DB updated: Cell ${endNodeCell.id} marked as is_has_box = 1.`);

      // 2. Release Redis Lock for the endNode
      // Note: Lock key uses ID, so we needed the lookup
      const endNodeLockKey = `endnode:lock:${endNodeCell.id}`;
      await ReservationService.releaseLock(endNodeLockKey);

    } else {
      logger.error(`[TaskEventListener] Cannot find endNode cell QR '${taskDetails.endNodeQr}' in DB. Cannot update is_has_box or release lock.`);
    }

    // 4. Final step: update task status to completed
    await shuttleTaskQueueService.updateTaskStatus(taskId, 'completed');
    logger.info(`[TaskEventListener] Task ${taskId} successfully completed by shuttle ${shuttleId}.`);

    // 5. Keep node occupation - shuttle is still physically at this node
    // The node will be unblocked automatically when shuttle moves to next task
    logger.debug(`[TaskEventListener] Shuttle ${shuttleId} remains at current node, keeping occupation`);

    // 6. Proactively trigger the next dispatch cycle after a short delay
    if (this.dispatcher) {
      logger.info(`[TaskEventListener] Proactively triggering next dispatch cycle in 1 second.`);
      setTimeout(() => this.dispatcher.dispatchNextTask(), 1000);
    }
  }
}

// Export a single instance
module.exports = new TaskEventListener();