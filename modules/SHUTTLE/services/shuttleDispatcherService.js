const { logger } = require('../../../config/logger');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const { getAllShuttleStates } = require('./shuttleStateCache');
const { publishToTopic } = require('../../../services/mqttClientService');
const cellService = require('./cellService');
const { findShortestPath } = require('./pathfinding');
const ReservationService = require('../../COMMON/reservationService');
const PathCacheService = require('./PathCacheService');
const ShuttleCounterService = require('./ShuttleCounterService');
const { TASK_ACTIONS, MQTT_TOPICS, MISSION_CONFIG } = require('../../../config/shuttle.config');
const { getShuttleState, updateShuttleState } = require('./shuttleStateCache');
const NodeOccupationService = require('./NodeOccupationService');
const MissionCoordinatorService = require('./MissionCoordinatorService');

const PICKUP_LOCK_TIMEOUT = 300; // 5 minutes

class ShuttleDispatcherService {
  constructor(io) {
    this._io = io;
    this._dispatchInterval = 5000;
    this._dispatcherTimer = null;
    this._activeMissions = new Map(); // Track active missions for retry mechanism
  }

  /**
   * Publishes a mission to a shuttle with automatic retry mechanism.
   * Retries every 500ms for up to 30 seconds if no response is received.
   * @param {string} topic - MQTT topic to publish to
   * @param {object} payload - Mission payload
   * @param {string} shuttleId - Shuttle identifier
   */
  async publishMissionWithRetry(topic, payload, shuttleId) {
    const missionId = `${shuttleId}_${Date.now()}`;
    const startTime = Date.now();
    let retryCount = 0;
    let acknowledged = false;

    // Initial publish
    await publishToTopic(topic, payload);

    const retryInterval = setInterval(async () => {
      // Check if already acknowledged (to avoid unnecessary checks)
      if (acknowledged) {
        return;
      }

      const elapsed = Date.now() - startTime;
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
        const reason = isActuallyRunningOurTask ? 'Task ID Match' : isBusy ? 'Shuttle Busy' : 'Command ACK (0)';
        clearInterval(retryInterval);
        this._activeMissions.delete(missionId);
        logger.debug(`[ShuttleDispatcherService] Mission ${missionId} acknowledged. Reason: ${reason}`);
        return;
      }

      // Check timeout
      if (elapsed >= MISSION_CONFIG.RETRY_TIMEOUT) {
        logger.error(
          `[ShuttleDispatcherService] Mission ${missionId} timed out after ${MISSION_CONFIG.RETRY_TIMEOUT}ms. No response from shuttle ${shuttleId}`,
        );
        clearInterval(retryInterval);
        this._activeMissions.delete(missionId);
        return;
      }

      // Publish/retry the mission
      retryCount++;
      logger.debug(
        `[ShuttleDispatcherService] Retrying mission to ${topic} (attempt ${retryCount}, elapsed: ${elapsed}ms)`,
      );
      await publishToTopic(topic, payload);
    }, MISSION_CONFIG.RETRY_INTERVAL);

    // Store the interval reference for potential cleanup
    this._activeMissions.set(missionId, { interval: retryInterval, startTime, shuttleId });
  }

  /**
   * Calculate distance heuristic (Manhattan distance).
   * Considers floor changes as a significant penalty.
   */
  async calculateDistanceHeuristic(coords1, coords2) {
    if (!coords1 || !coords2) {
      return Infinity;
    }

    const { col: col1, row: row1, floorId: floor1 } = coords1;
    const { col: col2, row: row2, floorId: floor2 } = coords2;

    if (floor1 !== floor2) {
      // Large penalty for floor change (e.g., 1000 units)
      return 1000 + Math.abs(col1 - col2) + Math.abs(row1 - row2);
    }

    return Math.abs(col1 - col2) + Math.abs(row1 - row2);
  }

  /**
   * Determine row traffic direction based on pickup node and end node.
   * @returns {number} Direction code (1=LEFT_TO_RIGHT, 2=RIGHT_TO_LEFT)
   */
  async determineRowTrafficDirection(startQr, pickupQr, floorId, targetRow) {
    try {
      const pickupCell = await cellService.getCellByQrCode(pickupQr, floorId);

      if (!pickupCell) {
        return 1; // Default: LEFT_TO_RIGHT
      }

      // Pickup node is usually in T-column (leftmost column)
      // Direction is determined by movement into the storage area (left to right)
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
      taskPickupCoords = await cellService.getCellByQrCode(task.pickupNodeQr, task.pickupNodeFloorId);
      if (!taskPickupCoords) {
        logger.warn(`Task pickupNodeQr ${task.pickupNodeQr} on floor ${task.pickupNodeFloorId} not found.`);
        return null;
      }

      for (const shuttle of idleShuttles) {
        let shuttleCurrentCoords = null;
        const candidates = await cellService.getCellByQrCodeAnyFloor(shuttle.currentNode);

        if (!candidates || candidates.length === 0) {
          const currentNodeName = await cellService.getDisplayNameWithoutFloor(shuttle.currentNode);
          logger.warn(`Shuttle ${shuttle.id} currentNode ${currentNodeName} not found in DB.`);
          continue;
        }

        shuttleCurrentCoords = candidates[0];
        const distance = await this.calculateDistanceHeuristic(shuttleCurrentCoords, taskPickupCoords);

        if (distance < minDistance) {
          minDistance = distance;
          optimalShuttle = {
            ...shuttle,
            qrCode: shuttle.currentNode,
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
      // 1. Get the next pending task (FIFO)
      task = await shuttleTaskQueueService.getNextPendingTask();
      if (!task) {
        logger.debug('[ShuttleDispatcherService] No pending tasks found.');
        return;
      }

      // 2. Attempt to lock the pickupNode
      pickupResourceKey = `pickup:lock:${task.pickupNodeQr}`;
      let isLockAcquired = await ReservationService.acquireLock(pickupResourceKey, task.taskId, PICKUP_LOCK_TIMEOUT);

      if (!isLockAcquired) {
        const currentOwner = await ReservationService.getLockOwner(pickupResourceKey);
        if (currentOwner === task.taskId) {
          isLockAcquired = true;
        } else {
          return;
        }
      }

      // 3. Find optimal shuttle
      const allShuttleStates = await getAllShuttleStates();
      const idleShuttles = allShuttleStates
        .filter((s) => s.shuttleStatus === 8) // 8 = IDLE
        .map((s) => ({
          ...s,
          id: s.id || s.no,
          currentNode: s.currentNode,
        }));

      if (idleShuttles.length === 0) {
        logger.debug('[ShuttleDispatcherService] No idle shuttles available.');
        return;
      }

      const optimalShuttle = await this.findOptimalShuttle(task, idleShuttles);
      if (!optimalShuttle) {
        return;
      }

      // 4. Dispatch task to the chosen shuttle
      return await this.dispatchTaskToShuttle(task, optimalShuttle.id);
    } catch (error) {
      logger.error('[ShuttleDispatcherService] Error during task dispatch:', error);
      if (pickupResourceKey && task) {
        logger.error(`[ShuttleDispatcherService] Releasing lock for ${pickupResourceKey} due to error.`);
        await ReservationService.releaseLock(pickupResourceKey);
      }
    }
  }

  /**
   * Directly assign and send a mission to a specific shuttle.
   */
  async dispatchTaskToShuttle(task, shuttleId) {
    try {
      const shuttleState = await getShuttleState(shuttleId);

      if (!shuttleState) {
        throw new Error(`Shuttle ${shuttleId} state not found`);
      }

      // 1. Calculate Path using Unified Mission Coordinator
      const missionPayload = await MissionCoordinatorService.calculateNextSegment(
        shuttleId,
        task.pickupNodeQr,
        task.pickupNodeFloorId,
        {
          taskId: task.taskId,
          onArrival: 'PICKUP_COMPLETE',
          pickupNodeQr: task.pickupNodeQr,
          endNodeQr: task.endNodeQr,
          itemInfo: task.itemInfo,
          isCarrying: false,
        },
      );

      const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;
      await this.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);

      // 2. Update Task Status & Shuttle State
      await shuttleTaskQueueService.updateTaskStatus(task.taskId, 'assigned', shuttleId);

      // 3. Update shuttle counter
      await ShuttleCounterService.updateCounter();

      return { success: true, taskId: task.taskId };
    } catch (error) {
      logger.error(`[ShuttleDispatcherService] Error in dispatchTaskToShuttle: ${error.message}`);
      throw error;
    }
  }

  startDispatcher() {
    if (this._dispatcherTimer) {
      logger.warn('[ShuttleDispatcherService] Dispatcher is already running.');
      return;
    }
    this._dispatcherTimer = setInterval(() => this.dispatchNextTask(), this._dispatchInterval);
  }

  stopDispatcher() {
    if (this._dispatcherTimer) {
      clearInterval(this._dispatcherTimer);
      this._dispatcherTimer = null;
    }
  }
}

module.exports = ShuttleDispatcherService;
