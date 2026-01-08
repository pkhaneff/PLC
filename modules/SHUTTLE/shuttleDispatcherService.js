const { logger } = require('../../logger/logger');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const { getAllShuttleStates } = require('./shuttleStateCache'); // Use in-memory cache
const { publishToTopic } = require('../../services/mqttService'); // To publish commands
const cellService = require('./cellService'); // Using the alias NodeService internally
const { findShortestPath } = require('./pathfinding');
const ReservationService = require('../COMMON/reservationService'); // Import the new service

const PICKUP_LOCK_TIMEOUT = 300; // 5 minutes, same as endnode for consistency

class ShuttleDispatcherService {
  constructor(io) { // appEvents no longer needed here
    this.io = io;
    this.dispatchInterval = 5000;
    this.dispatcherTimer = null;
    logger.info('[ShuttleDispatcherService] Initialized.');
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
      // Get coordinates for the task's pickup node on the specified floor
      taskPickupCoords = await cellService.getCellByName(task.pickupNode, task.pickupNodeFloorId);
      if (!taskPickupCoords) {
        logger.warn(`Task pickupNode ${task.pickupNode} on floor ${task.pickupNodeFloorId} not found in cellService.`);
        return null;
      }

      for (const shuttle of idleShuttles) {
        let shuttleCurrentCoords = null;
        // CORRECTED: Use getCellByQrCode since shuttle.current_node is a QR code
        shuttleCurrentCoords = await cellService.getCellByQrCode(shuttle.current_node, taskPickupCoords.floor_id);
          
        if (!shuttleCurrentCoords) {
          logger.warn(`Shuttle ${shuttle.id} current_node (QR: ${shuttle.current_node}) not found on floor ${taskPickupCoords.floor_id} in cellService.`);
          continue; // Skip this shuttle
        }

        const distance = await this.calculateDistanceHeuristic(shuttleCurrentCoords, taskPickupCoords);

        if (distance < minDistance) {
          minDistance = distance;
          optimalShuttle = shuttle;
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
        logger.info('[ShuttleDispatcherService] No pending tasks found.');
        return; // No pending tasks
      }
      logger.info(`[ShuttleDispatcherService] Found pending task: ${task.taskId}`);

      // 2. Attempt to lock the pickupNode, or verify we already own the lock
      pickupResourceKey = `pickup:lock:${task.pickupNode}`;
      let isLockAcquired = await ReservationService.acquireLock(pickupResourceKey, task.taskId, PICKUP_LOCK_TIMEOUT);

      if (!isLockAcquired) {
        // If lock failed, check if we are already the owner
        const currentOwner = await ReservationService.getLockOwner(pickupResourceKey);
        if (currentOwner === task.taskId) {
          logger.info(`[Dispatcher] Verified that current task ${task.taskId} already owns the lock for ${task.pickupNode}. Proceeding.`);
          isLockAcquired = true; // We can proceed
        } else {
          logger.info(`[Dispatcher] Pickup node ${task.pickupNode} is locked by another task (${currentOwner}). Task ${task.taskId} will be retried.`);
          return; // Locked by someone else, so we wait.
        }
      }

      // 3. Validate pickup node. This is a critical failure if it fails.
      const pickupCell = await cellService.getCellByName(task.pickupNode, task.pickupNodeFloorId);
      if (!pickupCell) {
        logger.error(`[Dispatcher] UNRECOVERABLE: Pickup node ${task.pickupNode} not found for task ${task.taskId}. Removing task and releasing lock.`);
        await shuttleTaskQueueService.removeTask(task.taskId); // Clean up bad task
        await ReservationService.releaseLock(pickupResourceKey); // Release lock as task is invalid
        return;
      }

      // 4. Find available shuttles
      const allShuttles = getAllShuttleStates();
      const idleShuttles = allShuttles
        .filter(s => s.shuttleStatus === 8) // 8 = IDLE
        .map(s => ({ ...s, id: s.no, current_node: s.qrCode }));

      if (!idleShuttles || idleShuttles.length === 0) {
        logger.warn(`No idle shuttles available. Task ${task.taskId} will be retried. The pickupNode lock is HELD.`);
        return; // Lock is held, just exit and retry next cycle
      }

      // 5. Select the optimal shuttle
      const optimalShuttle = await this.findOptimalShuttle(task, idleShuttles);
      if (!optimalShuttle) {
        logger.warn(`No optimal shuttle found for task ${task.taskId}. Task will be retried. The pickupNode lock is HELD.`);
        return; // Lock is held, just exit and retry next cycle
      }
      
      // 6. Determine shuttle's current floor by looking up its current QR code
      const shuttleCurrentCell = await cellService.getCellByQrCodeAnyFloor(optimalShuttle.current_node);
      if (!shuttleCurrentCell || shuttleCurrentCell.length === 0) {
        logger.error(`[Dispatcher] Shuttle ${optimalShuttle.id} current position ${optimalShuttle.current_node} not found in database. Task ${task.taskId} will be retried. The pickupNode lock is HELD.`);
        return; // Lock is held, just exit and retry next cycle
      }

      const shuttleFloorId = shuttleCurrentCell[0].floor_id;
      logger.debug(`[Dispatcher] Shuttle ${optimalShuttle.id} is on floor ${shuttleFloorId}, pickup is on floor ${task.pickupNodeFloorId}`);

      // 7. Calculate Path 1 (Current -> Pickup)
      // NOTE: Current pathfinding only works within a single floor
      // Ensure both values are numbers for comparison to avoid type mismatch issues.
      if (Number(shuttleFloorId) !== Number(task.pickupNodeFloorId)) {
        logger.warn(`[Dispatcher] Cross-floor pathfinding not yet supported. Shuttle ${optimalShuttle.id} is on floor ${shuttleFloorId}, but pickup ${task.pickupNode} is on floor ${task.pickupNodeFloorId}. Task ${task.taskId} will be retried. The pickupNode lock is HELD.`);
        return; // Lock is held, just exit and retry next cycle
      }

      const fullPath = await findShortestPath(optimalShuttle.current_node, task.pickupNode, task.pickupNodeFloorId);
      if (!fullPath) {
        logger.warn(`No path found for shuttle ${optimalShuttle.id} to ${task.pickupNode}. Task ${task.taskId} will be retried. The pickupNode lock is HELD.`);
        return; // Lock is held, just exit and retry next cycle
      }

      // 8. SUCCESS: All checks passed. Officially assign and dispatch.
      // The pickupNode lock is now active and owned by this task.
      logger.info(`[ShuttleDispatcherService] Assigning task ${task.taskId} to optimal shuttle ${optimalShuttle.id}.`);
      await shuttleTaskQueueService.updateTaskStatus(task.taskId, 'assigned', optimalShuttle.id);

      // Send command with Path 1 and the event to signal on arrival
      const commandTopic = `shuttle/command/${optimalShuttle.id}`;
      const commandPayload = {
        path: fullPath,
        onArrival: 'PICKUP_COMPLETE', // Tell the simulator the exact event to fire
        taskInfo: task // Also send task info for context
      };
      
      publishToTopic(commandTopic, commandPayload);

      logger.info(`[ShuttleDispatcherService] Command with Path 1 sent to shuttle ${optimalShuttle.id} on topic ${commandTopic}.`);

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
