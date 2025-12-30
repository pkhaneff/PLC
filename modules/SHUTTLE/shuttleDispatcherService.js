const { logger } = require('../../logger/logger');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const { getAllShuttleStates } = require('./shuttleStateCache'); // Use in-memory cache
const { publishToTopic } = require('../../services/mqttService'); // To publish commands
const cellService = require('./cellService'); // Using the alias NodeService internally
const mapf = require('./multiAgentPathFinding'); // New import for pathfinding (for conflict resolution)
const { findShortestPath } = require('./pathfinding'); // New import for floor-specific pathfinding

class ShuttleDispatcherService {
  constructor(io) {
    this.io = io; // Store the Socket.IO instance
    this.dispatchInterval = 5000; // Poll every 5 seconds for new tasks
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

        console.log(`[Dispatcher] Comparing floors: Task floor=${taskPickupCoords.floor_id}, Shuttle ${shuttle.id} floor=${shuttleCurrentCoords.floor_id}`); // DEBUG LOG

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
    try {
      logger.debug('[ShuttleDispatcherService] Attempting to dispatch next task...');

      // 1. Get the next pending task (FIFO)
      const task = await shuttleTaskQueueService.getNextPendingTask();
      if (!task) {
        logger.debug('[ShuttleDispatcherService] No pending tasks.');
        return;
      }
      console.log('[Dispatcher] Dequeued task with data:', JSON.stringify(task)); // DEBUG LOG POINT 3 - Force stringify

      logger.debug(`[ShuttleDispatcherService] Found pending task: ${task.taskId}`);

      // 2. Get a list of currently available idle shuttles from the in-memory cache
      const allShuttles = getAllShuttleStates();
      const idleShuttles = allShuttles
        .filter(s => s.shuttleStatus === 8) // 8 = IDLE
        .map(s => ({ ...s, id: s.no, current_node: s.qrCode })); // Adapt to expected structure

      if (!idleShuttles || idleShuttles.length === 0) {
        logger.warn(`[ShuttleDispatcherService] No idle shuttles available in cache for task ${task.taskId}. Task remains pending.`);
        return;
      }

      logger.debug(`[ShuttleDispatcherService] Found ${idleShuttles.length} idle shuttles.`);


      // 3. Select the optimal shuttle using a distance-based heuristic
      const optimalShuttle = await this.findOptimalShuttle(task, idleShuttles);

      if (!optimalShuttle) {
        logger.warn(`[ShuttleDispatcherService] Could not find an optimal shuttle for task ${task.taskId}. Task remains pending.`);
        return;
      }

      logger.info(`[ShuttleDispatcherService] Assigning task ${task.taskId} to optimal shuttle ${optimalShuttle.id}.`);

      // 4. Assign task to the chosen shuttle
      await shuttleTaskQueueService.updateTaskStatus(task.taskId, 'assigned', optimalShuttle.id);

      // 6. Send command to shuttle agent via MQTT
      const commandTopic = `shuttle/command/${optimalShuttle.id}`;
      publishToTopic(commandTopic, fullPath);
      
      logger.info(`[ShuttleDispatcherService] Command with path sent to shuttle ${optimalShuttle.id} on topic ${commandTopic}.`);

    } catch (error) {
      logger.error('[ShuttleDispatcherService] Error during task dispatch:', error);
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

