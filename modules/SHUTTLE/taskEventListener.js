const mqtt = require('mqtt');
const mqttClientService = require('../../services/mqttClientService');
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
const { cellRepository: CellRepository, lifterService } = require('../../core/bootstrap');
const controller = require('../../controllers/shuttle.controller');
const MissionCoordinatorService = require('./MissionCoordinatorService');

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://10.14.80.78:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || 'admin';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || 'thaco@123';
const SHUTTLE_IDLE_STATUS = 8; // Define constant for IDLE status

class TaskEventListener {
  constructor() {
    this.client = null;
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
    // Create MQTT connection when initialize is called
    logger.info('[TaskEventListener] Initializing MQTT connection...');
    this.client = mqtt.connect(MQTT_BROKER_URL, {
      clientId: `task_event_listener_${Date.now()}`,
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,
    });

    // Ensure we only subscribe and set up message handling AFTER a successful connection.
    this.client.on('connect', () => {
      logger.info('[TaskEventListener] Connected to MQTT broker');
      this.client.subscribe(this.EVENTS_TOPIC, (err) => {
        if (err) {
          logger.error(`[TaskEventListener] Failed to subscribe to topic: ${this.EVENTS_TOPIC}`, err);
        } else {
          logger.info(`[TaskEventListener] Subscribed to ${this.EVENTS_TOPIC}`);
        }
      });
    });

    this.client.on('message', (topic, message) => {
      logger.info(`[TaskEventListener] Received message on topic: ${topic}`);
      if (topic === this.EVENTS_TOPIC) {
        this.handleEvent(message);
      }
    });

    this.client.on('error', (err) => {
      logger.error('[TaskEventListener] MQTT client connection error:', err);
    });

    // --- Redis Subscriber for Lifter Events ---
    this.subscriber = redisClient.duplicate();
    this.subscriber
      .connect()
      .then(() => {
        logger.info('[TaskEventListener] Redis Subscriber connected');
        this.subscriber.subscribe('lifter:events', (message) => {
          try {
            const payload = JSON.parse(message);
            this.handleLifterEvent(payload);
          } catch (e) {
            logger.error('[TaskEventListener] Error parsing lifter event:', e);
          }
        });
      })
      .catch((err) => {
        logger.error('[TaskEventListener] Redis Subscriber connection failed:', err);
      });
  }

  async handleLifterEvent(payload) {
    const { event, floorId, shuttleId } = payload;
    logger.info(`[TaskEventListener] Received Redis event: ${event} for F${floorId}`);

    if (event === 'LIFTER_ARRIVED') {
      const waitingKey = `waiting:lifter:${floorId}`;
      const waitingShuttles = await redisClient.sMembers(waitingKey);

      if (waitingShuttles && waitingShuttles.length > 0) {
        logger.info(
          `[TaskEventListener] Found ${waitingShuttles.length} shuttles waiting for Lifter at F${floorId}. Resuming...`
        );

        for (const sId of waitingShuttles) {
          // Resume shuttle
          if (this.dispatcher) {
            // We need to re-dispatch the CURRENT task of the shuttle.
            const taskInfo = await shuttleTaskQueueService.getShuttleTask(sId);
            if (taskInfo) {
              logger.info(`[TaskEventListener] Resuming task ${taskInfo.taskId} for shuttle ${sId}`);
              // Dispatcher will recalculate path. Since Lifter is here, it will generate path INTO lifter.
              await this.dispatcher.dispatchTaskToShuttle(taskInfo, sId);
              // Remove from waiting set
              await redisClient.sRem(waitingKey, sId);
            } else {
              logger.warn(`[TaskEventListener] Shuttle ${sId} waiting but no active task found.`);
              await redisClient.sRem(waitingKey, sId);
            }
          }
        }
      }
    }
  }

  async handleEvent(message) {
    try {
      if (!message || message.length === 0) {
        logger.debug('[TaskEventListener] Received an empty message. Ignoring.');
        return;
      }
      const eventPayload = JSON.parse(message.toString());
      let { event, taskId, shuttleId } = eventPayload;

      // Try to extract taskId into variable IF NOT PRESENT
      if (!taskId) {
        if (eventPayload.taskInfo && eventPayload.taskInfo.taskId) {
          taskId = eventPayload.taskInfo.taskId;
        } else if (eventPayload.meta && eventPayload.meta.taskId) {
          taskId = eventPayload.meta.taskId;
        }
      }

      logger.info(`[TaskEventListener] Parsed event: ${event}, shuttleId: ${shuttleId}, taskId: ${taskId}`);

      if (!event) return;

      switch (event) {
        case 'WAITING_FOR_LIFTER':
          logger.info(`[TaskEventListener] Shuttle ${shuttleId} is WAITING for Lifter.`);
          if (eventPayload.meta && eventPayload.meta.waitingFloor) {
            const floor = eventPayload.meta.waitingFloor;
            await redisClient.sAdd(`waiting:lifter:${floor}`, shuttleId);
            // Also update task status if needed
            if (taskId) {
              await shuttleTaskQueueService.updateTaskStatus(taskId, 'waiting_for_lifter');
            }

            // CRITICAL FIX: Check if lifter is ALREADY there
            // Race condition: Lifter might have arrived BEFORE shuttle sent WAITING_FOR_LIFTER
            const LifterCoordinationService = require('../Lifter/LifterCoordinationService');
            const lifterStatus = await LifterCoordinationService.getLifterStatus();

            const isLifterAtFloor = lifterStatus && String(lifterStatus.currentFloor) === String(floor);
            const isLifterBusy = lifterStatus && lifterStatus.status === 'MOVING';

            if (isLifterAtFloor && !isLifterBusy) {
              logger.info(
                `[TaskEventListener] Lifter already at F${floor} and idle. Resuming shuttle ${shuttleId} immediately.`
              );

              // Resume shuttle logic (duplicated from handleLifterEvent for now to be safe)
              if (this.dispatcher) {
                const taskInfo = await shuttleTaskQueueService.getShuttleTask(shuttleId);
                if (taskInfo) {
                  logger.info(
                    `[TaskEventListener] Immediate Resume: Resuming task ${taskInfo.taskId} for shuttle ${shuttleId}`
                  );
                  await this.dispatcher.dispatchTaskToShuttle(taskInfo, shuttleId);
                  await redisClient.sRem(`waiting:lifter:${floor}`, shuttleId);
                }
              }
            }
          }
          break;

        case 'shuttle-task-started':
          if (taskId) {
            // Update task status to in_progress as soon as shuttle starts moving
            await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
          }
          break;

        case 'PICKUP_COMPLETE':
          if (taskId) {
            await this.handlePickupComplete(taskId, shuttleId);
          }
          break;

        case 'ARRIVED_AT_LIFTER':
          if (shuttleId) {
            await this.handleArrivedAtLifter(shuttleId, eventPayload);
          }
          break;

        case 'TASK_COMPLETE':
          if (taskId) {
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
          logger.debug(
            `[TaskEventListener] Ignoring informational event type: ${event}. Payload: ${message.toString()}`
          );
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

      const currentState = (await getShuttleState(shuttleId)) || {};
      await updateShuttleState(shuttleId, {
        ...currentState,
        current_node: initialNode,
        qrCode: initialNode,
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

      const currentState = (await getShuttleState(shuttleId)) || {};
      await updateShuttleState(shuttleId, {
        ...currentState,
        current_node: currentNode,
        qrCode: currentNode,
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
          logger.debug(
            `[TaskEventListener] Shuttle ${shuttleId} at safety exit but pickup not completed. Going TO pickup, not releasing lock.`
          );
          return;
        }

        // 2. Check if shuttle is carrying cargo
        const shuttleState = await getShuttleState(shuttleId);

        if (!shuttleState || !shuttleState.isCarrying) {
          // Not carrying cargo - should not happen if pickupCompleted is true, but check anyway
          logger.warn(
            `[TaskEventListener] Shuttle ${shuttleId} at safety exit with pickupCompleted=true but not carrying cargo!`
          );
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
    const taskKey = shuttleTaskQueueService.getTaskKey(taskId);

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
    await redisClient.hSet(taskKey, 'pickupCompleted', 'true');

    // --- ROW COORDINATION LOGIC (THACO SPECIFIC) ---
    const activeShuttleCount = await ShuttleCounterService.updateCounter();
    let enforceOneWay = activeShuttleCount >= 2 || !!taskDetails.batchId;

    let targetRow = null;
    let actualEndNodeQr = endNodeQr;

    if (enforceOneWay) {
      if (taskDetails.batchId) {
        targetRow = await RowCoordinationService.assignRowForBatch(taskDetails.batchId, endNodeQr, endNodeFloorId);
        if (!targetRow) {
          logger.error(`[TaskEventListener] Cannot assign row for batch ${taskDetails.batchId}.`);
          await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
          return;
        }

        const isEndNodeInRow = await RowCoordinationService.isNodeInAssignedRow(endNodeQr, endNodeFloorId, targetRow);
        if (!isEndNodeInRow) {
          const nearestNode = await RowCoordinationService.findNearestNodeInRow(
            pickupNodeQr,
            targetRow,
            endNodeFloorId
          );
          if (!nearestNode) {
            await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
            return;
          }
          actualEndNodeQr = nearestNode;
        }
      } else {
        const endNodeCell = await cellService.getCellByQrCode(endNodeQr, endNodeFloorId);
        if (endNodeCell) targetRow = endNodeCell.row;
      }
    } else {
      const endNodeCell = await cellService.getCellByQrCode(endNodeQr, endNodeFloorId);
      if (endNodeCell) targetRow = endNodeCell.row;
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
        shuttleId
      );
      if (!locked) {
        await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
        return;
      }
    }
    // --- END ROW COORDINATION ---

    try {
      // 1. Calculate Path using Unified Mission Coordinator
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
        }
      );

      // 2. Update shuttle package state in Redis
      const currentShuttleState = (await getShuttleState(shuttleId)) || {};
      await updateShuttleState(shuttleId, { ...currentShuttleState, isCarrying: true, packageStatus: 1 });
      await redisClient.hSet(taskKey, 'isCarrying', 'true');

      // 3. Send mission
      const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;
      if (this.dispatcher && this.dispatcher.publishMissionWithRetry) {
        await this.dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
      } else {
        mqttClientService.publishToTopic(missionTopic, missionPayload);
      }
    } catch (error) {
      logger.error(`[TaskEventListener] Error in unified Path 2 calculation: ${error.message}`);
      await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
    }
  }

  /**
   * Xử lý khi Shuttle đã tới cửa Lifter
   */
  async handleArrivedAtLifter(shuttleId, eventPayload) {
    try {
      const { finalTargetQr, finalTargetFloorId, taskId, isCarrying } = eventPayload.meta || {};
      if (!finalTargetFloorId || !taskId) {
        logger.error(`[TaskEventListener] ARRIVED_AT_LIFTER missing meta data for ${shuttleId}`);
        return;
      }

      logger.info(
        `[TaskEventListener] Shuttle ${shuttleId} arrived at Lifter. Calling lifter to target floor ${finalTargetFloorId}.`
      );

      // 1. Gọi Lifter tới tầng đích
      // LƯU Ý: Trong thực tế, Shuttle phải ĐI VÀO Lifter trước khi Lifter di chuyển.
      // Ở đây chúng ta mô phỏng: Lifter di chuyển Shuttle tới tầng đích.

      const moveResult = await lifterService.moveLifterToFloor(finalTargetFloorId);
      if (!moveResult.success) {
        throw new Error(`Failed to move lifter: ${moveResult.message}`);
      }

      logger.info(
        `[TaskEventListener] Lifter reached floor ${finalTargetFloorId}. Shuttle ${shuttleId} recalculating final leg.`
      );

      // 2. Sau khi tới tầng đích, Shuttle tính toán chặng cuối cùng từ Lifter tới Đích
      // Logic: Nếu chưa mang hàng (isCarrying=false) thì là chặng đi lấy hàng (PICKUP), ngược lại là đi cất hàng (TASK_COMPLETE)
      const targetArrivalEvent = isCarrying ? 'TASK_COMPLETE' : 'PICKUP_COMPLETE';
      const targetAction = isCarrying ? TASK_ACTIONS.DROP_OFF : TASK_ACTIONS.PICK_UP;

      const missionPayload = await MissionCoordinatorService.calculateNextSegment(
        shuttleId,
        finalTargetQr,
        finalTargetFloorId,
        {
          taskId: taskId,
          onArrival: targetArrivalEvent,
          isCarrying: isCarrying,
          action: targetAction,
          currentFloorId: finalTargetFloorId, // Thông báo cho logic là đang ở tầng đích
        }
      );

      // 3. Gửi mission chặng cuối
      const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;
      if (this.dispatcher && this.dispatcher.publishMissionWithRetry) {
        await this.dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
      } else {
        mqttClientService.publishToTopic(missionTopic, missionPayload);
      }
    } catch (error) {
      logger.error(`[TaskEventListener] Error in handleArrivedAtLifter for ${shuttleId}: ${error.message}`);
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
      const palletId =
        typeof taskDetails.itemInfo === 'object'
          ? taskDetails.itemInfo.id || JSON.stringify(taskDetails.itemInfo)
          : taskDetails.itemInfo;

      await cellService.updateCellHasBox(endNodeCell.id, true, palletId);

      const endNodeLockKey = `endnode:lock:${endNodeCell.id}`;
      await ReservationService.releaseLock(endNodeLockKey);
    } else {
      logger.error(
        `[TaskEventListener] Cannot find endNode cell QR '${taskDetails.endNodeQr}' in DB. Cannot update is_has_box or release lock.`
      );
    }

    await shuttleTaskQueueService.updateTaskStatus(taskId, 'completed');
    const endNodeName = await cellService.getCachedDisplayName(taskDetails.endNodeQr, taskDetails.endNodeFloorId);

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
    });

    // 7. Tự động xử lý inbound_pallet_queue sau khi shuttle IDLE
    // Logic: Ưu tiên autoProcessInboundQueue cho shuttle vừa complete (nếu trong executing mode)
    // Nếu queue rỗng hoặc shuttle không trong executing mode, fallback về dispatchNextTask
    const controller = require('../../controllers/shuttle.controller');
    setTimeout(async () => {
      const result = await controller.autoProcessInboundQueue(shuttleId);
      if (!result.success) {
        logger.debug(
          `[TaskEventListener] autoProcessInboundQueue failed (${result.reason}), falling back to dispatchNextTask`
        );
        if (this.dispatcher) {
          this.dispatcher.dispatchNextTask();
        }
      } else {
        logger.info(`[TaskEventListener] Shuttle ${shuttleId} automatically picked up next task from queue`);
      }
    }, 1000);

    await PathCacheService.deletePath(shuttleId);
  }
}

module.exports = new TaskEventListener();
