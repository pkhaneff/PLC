const { logger } = require('../../logger/logger');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const { getAllShuttleStates } = require('./shuttleStateCache'); // Use in-memory cache
const { publishToTopic } = require('../../services/mqttService'); // To publish commands
const cellService = require('./cellService'); // Using the alias NodeService internally
const { findShortestPath } = require('./pathfinding');
const ReservationService = require('../COMMON/reservationService'); // Import the new service
const PathCacheService = require('./PathCacheService'); // Import PathCacheService
const ShuttleCounterService = require('./ShuttleCounterService');
const { TASK_ACTIONS, MQTT_TOPICS, MISSION_CONFIG } = require('../../config/shuttle.config');

const PICKUP_LOCK_TIMEOUT = 300; // 5 minutes, same as endnode for consistency

class ShuttleDispatcherService {
  constructor(io) { // appEvents no longer needed here
    this.io = io;
    this.dispatchInterval = 5000;
    this.dispatcherTimer = null;
    this.activeMissions = new Map(); // Track active missions for retry mechanism
    logger.info('[ShuttleDispatcherService] Initialized.');
  }

  /**
   * Publishes a mission to a shuttle with automatic retry mechanism
   * Retries every 500ms for up to 30 seconds if no response is received
   * @param {string} topic - MQTT topic to publish to
   * @param {object} payload - Mission payload
   * @param {string} shuttleId - Shuttle identifier
   */
  async publishMissionWithRetry(topic, payload, shuttleId) {
    const missionId = `${shuttleId}_${Date.now()}`;
    const startTime = Date.now();
    let retryCount = 0;
    let acknowledged = false;

    logger.info(`[ShuttleDispatcherService] Starting mission ${missionId} for shuttle ${shuttleId}`);

    // Initial publish
    await publishToTopic(topic, payload);

    const retryInterval = setInterval(async () => {
      // Check if already acknowledged (to avoid unnecessary checks)
      if (acknowledged) {
        return;
      }

      const elapsed = Date.now() - startTime;

      const { getShuttleState } = require('./shuttleStateCache');
      const shuttleState = await getShuttleState(shuttleId);

      // Check for multiple ACK signals:
      // 1. commandComplete === 0 (standard MQTT ACK)
      // 2. OR shuttle is no longer IDLE (8) AND it's executing OUR task (taskId match)
      const targetTaskId = payload.meta ? payload.meta.taskId : null;
      const isActuallyRunningOurTask = targetTaskId && shuttleState && shuttleState.taskId === targetTaskId;
      const isBusy = shuttleState && shuttleState.shuttleStatus !== 8;

      if (shuttleState && (shuttleState.commandComplete === 0 || isActuallyRunningOurTask || isBusy)) {
        // Shuttle has acknowledged or started, stop retrying
        acknowledged = true;
        const reason = isActuallyRunningOurTask ? 'Task ID Match' : (isBusy ? 'Shuttle Busy' : 'Command ACK (0)');
        logger.info(`[ShuttleDispatcherService] Shuttle ${shuttleId} acknowledged mission ${missionId} (${reason}) after ${retryCount} retries (${elapsed}ms)`);
        clearInterval(retryInterval);
        this.activeMissions.delete(missionId);
        return;
      }

      // Check timeout
      if (elapsed >= MISSION_CONFIG.RETRY_TIMEOUT) {
        logger.error(`[ShuttleDispatcherService] Mission ${missionId} timed out after ${MISSION_CONFIG.RETRY_TIMEOUT}ms. No response from shuttle ${shuttleId}`);
        clearInterval(retryInterval);
        this.activeMissions.delete(missionId);
        // TODO: Handle timeout - maybe mark task as failed, release locks, etc.
        return;
      }

      // Publish/retry the mission
      retryCount++;
      logger.debug(`[ShuttleDispatcherService] Retrying mission to ${topic} (attempt ${retryCount}, elapsed: ${elapsed}ms)`);
      await publishToTopic(topic, payload);

    }, MISSION_CONFIG.RETRY_INTERVAL);

    // Store the interval reference for potential cleanup
    this.activeMissions.set(missionId, { interval: retryInterval, startTime, shuttleId });
  }

  // Helper function to calculate Manhattan distance (or similar heuristic)
  // Considers floor changes as a significant penalty
  async calculateDistanceHeuristic(coords1, coords2) {
    if (!coords1 || !coords2) {
      return Infinity;
    }

    const { col: col1, row: row1, floor_id: floor1 } = coords1;
    const { col: col2, row: row2, floor_id: floor2 } = coords2;

    if (floor1 !== floor2) {
      return Infinity;
    }

    return Math.abs(col1 - col2) + Math.abs(row1 - row2);
  }

  /**
   * Xác định row traffic direction dựa trên pickup node và end node
   * Logic: Direction được xác định bởi movement TRONG row từ pickup → end
   * @returns {number} Direction code (1=LEFT_TO_RIGHT, 2=RIGHT_TO_LEFT)
   */
  async determineRowTrafficDirection(startQr, pickupQr, floorId, targetRow) {
    try {
      // Lấy thông tin pickup node (đây là điểm vào row từ T-column)
      const pickupCell = await cellService.getCellByQrCode(pickupQr, floorId);

      if (!pickupCell) {
        return 1; // Default: LEFT_TO_RIGHT
      }

      // Pickup node thường ở T-column (cột trái nhất)
      // Direction được xác định bởi: Từ pickup node, shuttle sẽ đi sang phải (LEFT_TO_RIGHT)
      // vì tất cả storage nodes đều ở bên phải pickup node

      // CRITICAL: Luôn luôn return LEFT_TO_RIGHT vì pickup node luôn ở bên trái cùng
      // Tất cả shuttle đều vào từ pickup node và đi sang phải vào storage area
      return 1; // LEFT_TO_RIGHT

    } catch (error) {
      logger.error('[ShuttleDispatcherService] Error determining row traffic direction:', error);
      return 1; // Default: LEFT_TO_RIGHT
    }
  }

  async findOptimalShuttle(task, idleShuttles) {
    if (!task || !idleShuttles || idleShuttles.length === 0) {
      return null;
    }

    let minDistance = Infinity;
    let optimalShuttle = null;
    let taskPickupCoords = null;

    try {
      // Get coordinates for the task's pickup node (now using QR)
      taskPickupCoords = await cellService.getCellByQrCode(task.pickupNodeQr, task.pickupNodeFloorId);
      if (!taskPickupCoords) {
        const pickupName = await cellService.getCachedDisplayName(task.pickupNodeQr, task.pickupNodeFloorId);
        logger.warn(`Task pickupNodeQr ${pickupName} on floor ${task.pickupNodeFloorId} not found in cellService.`);
        return null;
      }

      for (const shuttle of idleShuttles) {
        let shuttleCurrentCoords = null;
        // Search globally for the shuttle's current node to handle cases where it might be on a different floor
        const candidates = await cellService.getCellByQrCodeAnyFloor(shuttle.current_node);

        if (!candidates || candidates.length === 0) {
          const currentNodeName = await cellService.getDisplayNameWithoutFloor(shuttle.current_node);
          logger.warn(`Shuttle ${shuttle.id} current_node ${currentNodeName} not found in DB (Any Floor).`);
          continue;
        }

        // Use the cell that matches the task's floor, or the first one if we want to check floor mismatch
        // Ideally, a QR should be unique or we prioritize the one on the target floor.
        shuttleCurrentCoords = candidates.find(c => c.floor_id === taskPickupCoords.floor_id);

        if (!shuttleCurrentCoords) {
          // Shuttle is likely on a different floor
          const actualFloor = candidates[0].floor_id;
          logger.debug(`Shuttle ${shuttle.id} is on floor ${actualFloor}, but task is on floor ${taskPickupCoords.floor_id}. Skipping.`);
          continue;
        }

        const distance = await this.calculateDistanceHeuristic(shuttleCurrentCoords, taskPickupCoords);

        if (distance < minDistance) {
          minDistance = distance;
          optimalShuttle = {
            ...shuttle,
            qrCode: shuttle.current_node // Ensure qrCode property is set
          };
        }
      }
    } catch (error) {
      logger.error('Error finding optimal shuttle:', error);
      return null;
    }

    return optimalShuttle;
  }

  async dispatchNextTask() {
    let task = null;
    let pickupResourceKey = '';

    try {
      logger.info('[ShuttleDispatcherService] Attempting to dispatch next task...');

      // 1. Get the next pending task (FIFO)
      task = await shuttleTaskQueueService.getNextPendingTask();
      if (!task) {
        logger.debug('[ShuttleDispatcherService] No pending tasks found.');
        return; // No pending tasks
      }
      logger.info(`[ShuttleDispatcherService] Found pending task: ${task.taskId}`);

      // 2. Attempt to lock the pickupNode, or verify we already own the lock
      // Use pickupNodeQr
      pickupResourceKey = `pickup:lock:${task.pickupNodeQr}`;
      let isLockAcquired = await ReservationService.acquireLock(pickupResourceKey, task.taskId, PICKUP_LOCK_TIMEOUT);

      if (!isLockAcquired) {
        // If lock failed, check if we are already the owner
        const currentOwner = await ReservationService.getLockOwner(pickupResourceKey);
        if (currentOwner === task.taskId) {
          isLockAcquired = true;
          logger.info(`[ShuttleDispatcherService] Task ${task.taskId} already owns lock for ${pickupResourceKey}. Proceeding.`);
        } else {
          const pickupName = await cellService.getCachedDisplayName(task.pickupNodeQr, task.pickupNodeFloorId);
          logger.warn(`[ShuttleDispatcherService] Pickup node ${pickupName} is locked by ${currentOwner}. Skipping task ${task.taskId} temporarily.`);
          // Should we unshift the task or just retry later?
          // Since getNextPendingTask peeks at the top, we are stuck on this task until it can be processed.
          // This simple FIFO logic means we block until the lock is free.
          return;
        }
      }

      // 3. Find optimal shuttle
      // CRITICAL FIX: getAllShuttleStates() is now async (reads from Redis)
      const allShuttleStates = await getAllShuttleStates();
      logger.info(`[DispatcherDebug] All states: ${JSON.stringify(allShuttleStates)}`);

      const idleShuttles = allShuttleStates
        .filter(s => s.shuttleStatus === 8) // 8 = IDLE
        .map(s => ({
          ...s,
          id: s.no || s.id, // Ensure ID is present
          current_node: s.current_node || s.qrCode // Prioritize current_node, fallback to qrCode
        }));

      logger.info(`[DispatcherDebug] Idle shuttles found: ${idleShuttles.length}`);

      if (idleShuttles.length === 0) {
        logger.debug('[ShuttleDispatcherService] No idle shuttles available.');
        return;
      }

      const optimalShuttle = await this.findOptimalShuttle(task, idleShuttles);
      logger.info(`[DispatcherDebug] Optimal shuttle: ${optimalShuttle ? optimalShuttle.id : 'null'}`);

      if (!optimalShuttle) {
        logger.info('[ShuttleDispatcherService] No suitable shuttle found (e.g., wrong floor or unreachable).');
        return;
      }

      const fromName = await cellService.getDisplayNameWithoutFloor(optimalShuttle.current_node);
      const toName = await cellService.getCachedDisplayName(task.pickupNodeQr, task.pickupNodeFloorId);
      logger.info(`[ShuttleDispatcherService] Found optimal shuttle ${optimalShuttle.id} for task ${task.taskId}. Path: ${fromName} -> ${toName}`);

      // 4. Dispatch task to the chosen shuttle
      return await this.dispatchTaskToShuttle(task, optimalShuttle.id);

    } catch (error) {
      logger.error('[ShuttleDispatcherService] Error during task dispatch:', error);
      // If a lock was acquired and an unexpected error occurred, release it to prevent a deadlock
      if (pickupResourceKey && task) {
        logger.error(`[ShuttleDispatcherService] Releasing lock for ${pickupResourceKey} due to unexpected error.`);
        await ReservationService.releaseLock(pickupResourceKey);
      }
    }
  }

  /**
   * Trực tiếp gán và gửi nhiệm vụ cho một shuttle cụ thể
   * @param {object} task - Dữ liệu task
   * @param {string} shuttleId - ID của shuttle
   */
  async dispatchTaskToShuttle(task, shuttleId) {
    try {
      const { getShuttleState } = require('./shuttleStateCache');
      const shuttleState = await getShuttleState(shuttleId);

      if (!shuttleState) {
        throw new Error(`Shuttle ${shuttleId} state not found`);
      }

      // 1. Calculate Path (Shuttle -> Pickup)
      const NodeOccupationService = require('./NodeOccupationService');
      const occupiedMap = await NodeOccupationService.getAllOccupiedNodes();

      const currentNode = shuttleState.current_node || shuttleState.qrCode;
      const avoidNodes = Object.keys(occupiedMap).filter(qr =>
        qr !== currentNode &&
        qr !== task.pickupNodeQr
      );

      logger.info(`[ShuttleDispatcherService] Planning path for ${shuttleId} to ${task.pickupNodeQr} avoiding ${avoidNodes.length} obstacles.`);

      const PathCacheService = require('./PathCacheService');
      const trafficData = await PathCacheService.getAllActivePaths();

      let fullPath = await findShortestPath(
        currentNode,
        task.pickupNodeQr,
        task.pickupNodeFloorId,
        {
          avoid: avoidNodes,
          isCarrying: false,
          trafficData: trafficData,
          lastStepAction: TASK_ACTIONS.PICK_UP
        }
      );

      // Fallback
      if (!fullPath) {
        logger.warn(`[ShuttleDispatcherService] Soft avoidance failed for shuttle ${shuttleId}. Trying direct path.`);
        fullPath = await findShortestPath(
          currentNode,
          task.pickupNodeQr,
          task.pickupNodeFloorId,
          {
            isCarrying: false,
            trafficData: trafficData,
            lastStepAction: TASK_ACTIONS.PICK_UP
          }
        );
      }

      if (!fullPath || !fullPath.totalStep || fullPath.totalStep === 0) {
        const fromName = await cellService.getDisplayNameWithoutFloor(currentNode);
        const toName = await cellService.getCachedDisplayName(task.pickupNodeQr, task.pickupNodeFloorId);
        throw new Error(`Failed to find valid path from ${fromName} to ${toName}`);
      }

      // 2. Save the path
      const PathCacheServiceModule = require('./PathCacheService');
      await PathCacheServiceModule.savePath(shuttleId, fullPath);

      const pathSteps = fullPath.steps || fullPath;

      // 3. Send mission via MQTT
      const missionTopic = `${MQTT_TOPICS.SEND_MISSION}/${shuttleId}`;
      const missionPayload = {
        ...pathSteps,
        meta: {
          taskId: task.taskId,
          onArrival: 'PICKUP_COMPLETE',
          step: 'move_to_pickup',
          pickupNodeQr: task.pickupNodeQr,
          endNodeQr: task.endNodeQr,
          itemInfo: task.itemInfo
        }
      };

      await this.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);

      // 4. Update Task Status & Shuttle State
      await shuttleTaskQueueService.updateTaskStatus(task.taskId, 'assigned', shuttleId);

      // 5. Update shuttle counter
      const ShuttleCounterService = require('./ShuttleCounterService');
      await ShuttleCounterService.updateCounter();

      logger.info(`[ShuttleDispatcherService] Task ${task.taskId} dispatched to shuttle ${shuttleId}.`);
      return { success: true, taskId: task.taskId };

    } catch (error) {
      logger.error(`[ShuttleDispatcherService] Error in dispatchTaskToShuttle: ${error.message}`);
      throw error;
    }
  }

  startDispatcher() {
    if (this.dispatcherTimer) {
      logger.warn('[ShuttleDispatcherService] Dispatcher is already running.');
      return;
    }
    logger.info(`[ShuttleDispatcherService] Starting dispatcher with interval: ${this.dispatchInterval / 1000}s`);
    this.dispatcherTimer = setInterval(() => this.dispatchNextTask(), this.dispatchInterval);
  }

  stopDispatcher() {
    if (this.dispatcherTimer) {
      clearInterval(this.dispatcherTimer);
      this.dispatcherTimer = null;
      logger.info('[ShuttleDispatcherService] Dispatcher stopped.');
    }
  }
}

module.exports = ShuttleDispatcherService;
