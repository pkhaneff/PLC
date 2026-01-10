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
      // Get coordinates for the task's pickup node (now using QR)
      taskPickupCoords = await cellService.getCellByQrCode(task.pickupNodeQr, task.pickupNodeFloorId);
      if (!taskPickupCoords) {
        logger.warn(`Task pickupNodeQr ${task.pickupNodeQr} on floor ${task.pickupNodeFloorId} not found in cellService.`);
        return null;
      }

      for (const shuttle of idleShuttles) {
        let shuttleCurrentCoords = null;
        // Use getCellByQrCode since shuttle.current_node is a QR code
        shuttleCurrentCoords = await cellService.getCellByQrCode(shuttle.current_node, taskPickupCoords.floor_id);

        if (!shuttleCurrentCoords) {
          logger.warn(`Shuttle ${shuttle.id} current_node (QR: ${shuttle.current_node}) not found on floor ${taskPickupCoords.floor_id} in cellService.`);
          continue; // Skip this shuttle
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
          logger.warn(`[ShuttleDispatcherService] Pickup node ${task.pickupNodeQr} is locked by ${currentOwner}. Skipping task ${task.taskId} temporarily.`);
          // Should we unshift the task or just retry later?
          // Since getNextPendingTask peeks at the top, we are stuck on this task until it can be processed.
          // This simple FIFO logic means we block until the lock is free.
          return;
        }
      }

      // 3. Find optimal shuttle
      const allShuttleStates = getAllShuttleStates(); // This is synchronous and fast
      logger.info(`[DispatcherDebug] All states: ${JSON.stringify(allShuttleStates)}`);

      const idleShuttles = Object.values(allShuttleStates)
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
      const fullPath = await findShortestPath(optimalShuttle.current_node, task.pickupNodeQr, task.pickupNodeFloorId);

      if (!fullPath) {
        logger.error(`[ShuttleDispatcherService] Failed to find path from ${optimalShuttle.current_node} to ${task.pickupNodeQr}`);
        return;
      }

      const pathSteps = fullPath.steps || fullPath; // Handle path format

      // 5. Send command to Shuttle
      const commandTopic = `shuttle/command/${optimalShuttle.id}`;
      const pathPayload = {
        action: 'move_path',
        taskId: task.taskId,
        path: pathSteps,
        final_destination: task.pickupNodeQr,
        // Additional info for the shuttle processing
        meta: {
          step: 'move_to_pickup',
          pickupNodeQr: task.pickupNodeQr,
          endNodeQr: task.endNodeQr,
          itemInfo: task.itemInfo
        }
      };

      // Note: We use pathPayload structure to match what simulator expects (path, taskInfo, onArrival, etc. might be needed)
      // Simulator expects: { path: [], taskInfo: {}, onArrival: 'EVENT_NAME' } based on previous code snippets?
      // Wait, let's look at Step 273 lines 156-160:
      /*
      const commandPayload = {
        path: fullPath,
        onArrival: 'PICKUP_COMPLETE', 
        taskInfo: task 
      };
      */
      // I should match that structure to be safe with simulator.

      const refinedPayload = {
        path: pathSteps,
        onArrival: 'PICKUP_COMPLETE',
        taskInfo: {
          ...task,
          pickupNode: task.pickupNodeQr, // Polyfill for legacy simulator checks if any
          endNode: task.endNodeQr
        },
        taskId: task.taskId
      };

      await publishToTopic(commandTopic, refinedPayload);

      // 6. Update Task Status & Shuttle State
      await shuttleTaskQueueService.updateTaskStatus(task.taskId, 'assigned', optimalShuttle.id);

      logger.info(`[ShuttleDispatcherService] Dispatched task ${task.taskId} to shuttle ${optimalShuttle.id}. Path length: ${pathSteps.length}`);

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
