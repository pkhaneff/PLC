const { logger } = require('../../logger/logger');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const { getAllShuttleStates } = require('./shuttleStateCache'); // Use in-memory cache
const { publishToTopic } = require('../../services/mqttService'); // To publish commands
const cellService = require('./cellService'); // Using the alias NodeService internally
const { findShortestPath } = require('./pathfinding');
const ReservationService = require('../COMMON/reservationService'); // Import the new service
const PathCacheService = require('./PathCacheService'); // Import PathCacheService
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

      // Check if shuttle has acknowledged (commandComplete should be 0 = IN_PROGRESS)
      const { getShuttleState } = require('./shuttleStateCache');
      const shuttleState = await getShuttleState(shuttleId);

      if (shuttleState && shuttleState.commandComplete === 0) {
        // Shuttle has acknowledged, stop retrying
        acknowledged = true;
        logger.info(`[ShuttleDispatcherService] Shuttle ${shuttleId} acknowledged mission ${missionId} after ${retryCount} retries (${elapsed}ms)`);
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
          current_node: s.qrCode // Map qrCode to current_node for consistency
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

      // 4. Calculate Path (Shuttle -> Pickup) (QR to QR)
      // optimalShuttle.current_node is QR (mapped above)

      // Dynamic Obstacle Avoidance: Get currently occupied nodes
      const NodeOccupationService = require('./NodeOccupationService');
      const occupiedMap = await NodeOccupationService.getAllOccupiedNodes();
      const avoidNodes = Object.keys(occupiedMap).filter(qr =>
        qr !== optimalShuttle.current_node && // Don't avoid myself
        qr !== task.pickupNodeQr            // Don't avoid my destination
      );

      logger.info(`[ShuttleDispatcherService] Planning path for ${optimalShuttle.id} avoiding ${avoidNodes.length} obstacles.`);


      // Get all active paths from PathCacheService for traffic awareness
      const trafficData = await PathCacheService.getAllActivePaths();
      logger.debug(`[ShuttleDispatcherService] Traffic data for pathfinding: ${JSON.stringify(trafficData.map(t => t.shuttleId))}`);

      logger.info(`[DispatcherDebug] Calling findShortestPath...`);
      let fullPath = await findShortestPath(
        optimalShuttle.current_node,
        task.pickupNodeQr,
        task.pickupNodeFloorId,
        {
          avoid: avoidNodes,
          isCarrying: false, // Shuttle is empty when going to pickup
          trafficData: trafficData, // Pass traffic data for proactive avoidance
          lastStepAction: TASK_ACTIONS.PICK_UP
        }
      );
      logger.info(`[DispatcherDebug] findShortestPath call completed.`);

      // 2. Fallback: If no path found avoiding obstacles, try direct path (ConflictResolution will handle yielding)
      if (!fullPath) {
        logger.warn(`[ShuttleDispatcherService] Soft avoidance failed for shuttle ${optimalShuttle.id}. Trying direct path.`);
        logger.info(`[DispatcherDebug] Calling findShortestPath (fallback)...`);
        fullPath = await findShortestPath(
          optimalShuttle.current_node,
          task.pickupNodeQr,
          task.pickupNodeFloorId,
          { 
            isCarrying: false, // Still empty on fallback
            trafficData: trafficData, // Pass traffic data for proactive avoidance
            lastStepAction: TASK_ACTIONS.PICK_UP
          }
        );
        logger.info(`[DispatcherDebug] findShortestPath (fallback) call completed.`);
      }

      if (!fullPath) {
        const fromName = await cellService.getDisplayNameWithoutFloor(optimalShuttle.current_node);
        const toName = await cellService.getCachedDisplayName(task.pickupNodeQr, task.pickupNodeFloorId);
        logger.error(`[ShuttleDispatcherService] Failed to find path from ${fromName} to ${toName}`);
        return;
      }

      // Ensure path has steps before saving
      if (!fullPath || !fullPath.totalStep || fullPath.totalStep === 0) {
        logger.error(`[ShuttleDispatcherService] Path calculated for task ${task.taskId} has no steps.`);
        return;
      }

      // Save the path to PathCacheService (Trụ cột 1)
      await PathCacheService.savePath(optimalShuttle.id, fullPath);
      logger.info(`[ShuttleDispatcherService] Path for shuttle ${optimalShuttle.id} (task ${task.taskId}) saved to PathCacheService.`);

      const pathSteps = fullPath.steps || fullPath; // Handle path format

      // 5. Send mission to Shuttle using new shuttle/sendMission topic
      const missionTopic = `${MQTT_TOPICS.SEND_MISSION}/${optimalShuttle.id}`;

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

      await this.publishMissionWithRetry(missionTopic, missionPayload, optimalShuttle.id);

      // 6. Update Task Status & Shuttle State
      await shuttleTaskQueueService.updateTaskStatus(task.taskId, 'assigned', optimalShuttle.id);

      const fromName = await cellService.getDisplayNameWithoutFloor(optimalShuttle.current_node);
      const toName = await cellService.getCachedDisplayName(task.pickupNodeQr, task.pickupNodeFloorId);
      logger.info(`[ShuttleDispatcherService] Dispatched task ${task.taskId} to shuttle ${optimalShuttle.id}. Path: ${fromName} -> ${toName} (${pathSteps.length} steps)`);

    } catch (error) {
      logger.error('[ShuttleDispatcherService] Error during task dispatch:', error);
      // If a lock was acquired and an unexpected error occurred, release it to prevent a deadlock
      if (pickupResourceKey && task) {
        logger.error(`[ShuttleDispatcherService] Releasing lock for ${pickupResourceKey} due to unexpected error.`);
        await ReservationService.releaseLock(pickupResourceKey);
      }
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
