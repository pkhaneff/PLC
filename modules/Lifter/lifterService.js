const lifterQueueService = require('./lifterQueueService');
const plcManager = require('../PLC/plcManager');
const { logger } = require('../../config/logger');

const FLOOR_1_ID = 138;
const FLOOR_2_ID = 139;
const DEFAULT_AVG_TASK_DURATION = 60;
const MAX_MOVE_TIME = 2000;
const CHECK_MOVE_INTERVAL = 500;

/**
 * LifterService - Refactored to use Dependency Injection.
 * Adheres to Dependency Inversion Principle.
 */
class LifterService {
  /**
   * @param {Object} dbConnection - Database connection instance (injected)
   */
  constructor(dbConnection) {
    this._db = dbConnection;
  }

  /**
   * Get lifter cell on a specific floor.
   * Each lifter has multiple cells on different floors but at the same position (col, row).
   * @param {number} floorId - Floor ID
   * @returns {Object|null} Lifter cell object: { name, col, row, floor_id, qr_code, cell_id }
   */
  async getLifterCellOnFloor(floorId) {
    try {
      const query = `
        SELECT c.id as cell_id, c.name, c.col, c.\`row\`, c.floor_id, c.qr_code, c.is_block,
               c.direction_type, c.cell_type, lc.lifter_id
        FROM lifter_cells lc
        JOIN cells c ON c.id = lc.cell_id
        WHERE c.floor_id = ? AND (c.is_block = 0 OR c.is_block IS NULL)
        LIMIT 1
      `;

      const [rows] = await this._db.execute(query, [floorId]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[LifterService] Error fetching lifter cell on floor: ${error.message}`);
      throw error;
    }
  }

  /**
   * Maps Database floor ID to Lifter index (1 or 2).
   * @param {number} floorId - Floor ID
   * @returns {number|null} Lifter index
   */
  mapFloorIdToLifterIndex(floorId) {
    // THACO logic: 138 -> 1 (Floor 1), 139 -> 2 (Floor 2)
    if (floorId == FLOOR_1_ID) {
      return 1;
    }
    if (floorId == FLOOR_2_ID) {
      return 2;
    }
    // If 1 or 2 is passed directly (legacy support)
    if (floorId == 1 || floorId == 2) {
      return floorId;
    }
    return null;
  }

  /**
   * Get all lifter cells on a floor (in case of multiple lifters).
   * @param {number} floorId - Floor ID
   * @returns {Array} List of lifter cells
   */
  async getAllLifterCellsOnFloor(floorId) {
    try {
      const query = `
        SELECT c.id as cell_id, c.name, c.col, c.\`row\`, c.floor_id, c.qr_code,
               c.is_block, c.direction_type, c.cell_type, lc.lifter_id
        FROM lifter_cells lc
        JOIN cells c ON c.id = lc.cell_id
        WHERE c.floor_id = ?
        ORDER BY c.col, c.\`row\`
      `;

      const [rows] = await this._db.execute(query, [floorId]);
      return rows;
    } catch (error) {
      logger.error(`[LifterService] Error fetching all lifter cells on floor: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if a floor has a lifter.
   * @param {number} floorId - Floor ID
   * @returns {boolean} True if lifter exists
   */
  async hasLifterOnFloor(floorId) {
    const lifterCell = await this.getLifterCellOnFloor(floorId);
    return lifterCell !== null;
  }

  /**
   * Get all idle lifters.
   * @returns {Array} List of available lifters
   */
  async getAvailableLifters() {
    try {
      const query = `
        SELECT id, name, status, current_cell_id, is_import_lifter, is_export_lifter
        FROM lifters
        WHERE status = 'idle' OR status = 'available'
        ORDER BY id
      `;

      const [rows] = await this._db.execute(query);
      return rows;
    } catch (error) {
      logger.error(`[LifterService] Error fetching available lifters: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get cells of a specific lifter across floors.
   * @param {number} lifterId - Lifter ID
   * @param {Array<number>} floorIds - List of floor IDs
   * @returns {Object} Object with floor_id as key, cell info as value
   */
  async getLifterCellsByFloors(lifterId, floorIds) {
    try {
      const placeholders = floorIds.map(() => '?').join(',');
      const query = `
        SELECT c.id as cell_id, c.name, c.col, c.\`row\`, c.floor_id, c.qr_code, c.is_block,
               c.direction_type, c.cell_type, lc.lifter_id
        FROM lifter_cells lc
        JOIN cells c ON c.id = lc.cell_id
        WHERE lc.lifter_id = ? AND c.floor_id IN (${placeholders})
        ORDER BY c.floor_id
      `;

      const [rows] = await this._db.execute(query, [lifterId, ...floorIds]);

      // Convert array to object { floor_id: cell_info }
      const result = {};
      for (const row of rows) {
        result[row.floor_id] = row;
      }

      return result;
    } catch (error) {
      logger.error(`[LifterService] Error fetching lifter cells by floors: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get lifter information by ID.
   * @param {number} lifterId - Lifter ID
   * @returns {Object|null} Lifter information
   */
  async getLifterById(lifterId) {
    try {
      const query = `
        SELECT id, name, status, current_cell_id, is_import_lifter, is_export_lifter
        FROM lifters
        WHERE id = ?
      `;

      const [rows] = await this._db.execute(query, [lifterId]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[LifterService] Error fetching lifter by ID: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if a lifter is available for a task.
   * @param {number} lifterId - Lifter ID
   * @returns {boolean} True if lifter is ready
   */
  async isLifterAvailable(lifterId) {
    try {
      const lifter = await this.getLifterById(lifterId);
      if (!lifter) {
        return false;
      }

      return lifter.status === 'idle' || lifter.status === 'available';
    } catch (error) {
      logger.error(`[LifterService] Error checking lifter availability: ${error.message}`);
      return false;
    }
  }

  /**
   * Request lifter usage for cross-floor tasks.
   * @param {number} fromFloor - Starting floor
   * @param {number} toFloor - Destination floor
   * @param {number} lifterId - Designated lifter ID
   * @param {Object} taskData - Additional task data
   * @returns {Object} Request result and queue info
   */
  async requestLifterForTask(fromFloor, toFloor, lifterId, taskData = {}) {
    try {
      // 1. Verify lifter exists
      const lifter = await this.getLifterById(lifterId);
      if (!lifter) {
        throw new Error(`Lifter ${lifterId} not found`);
      }

      // 2. Verify lifter has cells on both floors
      const cells = await this.getLifterCellsByFloors(lifterId, [fromFloor, toFloor]);
      if (!cells[fromFloor] || !cells[toFloor]) {
        throw new Error(`Lifter ${lifterId} does not have cells on both floors ${fromFloor} and ${toFloor}`);
      }

      // 3. Verify cells are not blocked
      if (cells[fromFloor].is_block === 1 || cells[toFloor].is_block === 1) {
        throw new Error(`Lifter ${lifterId} cells are blocked on one or both floors`);
      }

      // 4. Register task into Redis queue
      const queueInfo = await lifterQueueService.registerTask(fromFloor, toFloor, lifterId, {
        ...taskData,
        lifterName: lifter.name,
        fromCell: JSON.stringify(cells[fromFloor]),
        toCell: JSON.stringify(cells[toFloor]),
      });

      return {
        success: true,
        taskId: queueInfo.taskId,
        lifter: lifter,
        cells: cells,
        queueInfo: {
          positionInGlobalQueue: queueInfo.position,
          globalQueueLength: queueInfo.globalQueueLength,
          floorQueueLength: queueInfo.floorQueueLength,
          estimatedWaitTime: this.estimateWaitTime(queueInfo.position),
        },
      };
    } catch (error) {
      logger.error(`[LifterService] Error requesting lifter for task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Estimate wait time based on queue position.
   * @param {number} position - Position in queue
   * @returns {number} Estimated wait time in seconds
   */
  estimateWaitTime(position) {
    // Assuming each task takes an average of 60 seconds
    return (position - 1) * DEFAULT_AVG_TASK_DURATION;
  }

  /**
   * Get next task from the queue.
   * @returns {Object|null} Next task data
   */
  async getNextTaskFromQueue() {
    try {
      return await lifterQueueService.getNextTask();
    } catch (error) {
      logger.error(`[LifterService] Error getting next task from queue: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark task as processing.
   * @param {string} taskId - Task ID
   * @returns {boolean} Success
   */
  async startProcessingTask(taskId) {
    try {
      return await lifterQueueService.markTaskAsProcessing(taskId);
    } catch (error) {
      logger.error(`[LifterService] Error starting task processing: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark task as complete and retrieve the next one.
   * @param {string} taskId - Completed task ID
   * @returns {Object} Completion result and next task
   */
  async completeTaskAndGetNext(taskId) {
    try {
      return await lifterQueueService.completeTask(taskId);
    } catch (error) {
      logger.error(`[LifterService] Error completing task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get queue statistics.
   * @returns {Object} Statistics object
   */
  async getQueueStatistics() {
    try {
      return await lifterQueueService.getQueueStats();
    } catch (error) {
      logger.error(`[LifterService] Error getting queue statistics: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get tasks in a floor queue.
   * @param {number} floorId - Floor ID
   * @returns {Array} List of task details
   */
  async getFloorQueueTasks(floorId) {
    try {
      const taskIds = await lifterQueueService.getFloorQueue(floorId);
      const tasks = [];

      for (const taskId of taskIds) {
        const taskDetails = await lifterQueueService.getTaskDetails(taskId);
        if (taskDetails) {
          tasks.push(taskDetails);
        }
      }

      return tasks;
    } catch (error) {
      logger.error(`[LifterService] Error getting floor queue tasks: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get tasks in the global queue with a limit.
   * @param {number} limit - Max number of tasks
   * @returns {Array} List of tasks
   */
  async getGlobalQueueTasks(limit = 10) {
    try {
      return await lifterQueueService.getGlobalQueue(limit);
    } catch (error) {
      logger.error(`[LifterService] Error getting global queue tasks: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clear all queues.
   * @returns {boolean} Success
   */
  async clearAllQueues() {
    try {
      return await lifterQueueService.clearAllQueues();
    } catch (error) {
      logger.error(`[LifterService] Error clearing all queues: ${error.message}`);
      throw error;
    }
  }

  /**
   * Physically move lifter to a specific floor using PLC communication.
   * @param {number} logicalFloorId - Logical Floor ID (138, 139)
   * @param {string} plcId - PLC ID
   * @returns {Object} Operation result
   */
  async moveLifterToFloor(logicalFloorId, plcId = 'PLC_1') {
    try {
      const targetPhysFloor = this.mapFloorIdToLifterIndex(logicalFloorId);

      if (!targetPhysFloor) {
        throw new Error(
          `Invalid target floor: ${logicalFloorId}. Must be ${FLOOR_1_ID} (Floor 1) or ${FLOOR_2_ID} (Floor 2).`,
        );
      }

      logger.info(
        `[LifterService] Requesting lifter move to physical floor: ${targetPhysFloor} (Logical ID: ${logicalFloorId})`,
      );

      // 1. Check current position
      const posF1 = plcManager.getValue(plcId, 'LIFTER_1_POS_F1');
      const posF2 = plcManager.getValue(plcId, 'LIFTER_1_POS_F2');
      const currentPhysFloor = posF1 ? 1 : posF2 ? 2 : 0;

      if (currentPhysFloor === targetPhysFloor) {
        logger.info(`[LifterService] Lifter is already at floor ${targetPhysFloor}.`);
        return {
          success: true,
          message: `Lifter is already at floor ${targetPhysFloor}`,
          currentFloor: targetPhysFloor,
        };
      }

      // 2. Write control command to PLC
      const ctrlTag = targetPhysFloor === 1 ? 'LIFTER_1_CTRL_F1' : 'LIFTER_1_CTRL_F2';
      const writeResult = await plcManager.writeValue(plcId, ctrlTag, true);

      if (writeResult?.error) {
        throw new Error(`Failed to write control command to PLC: ${writeResult.error}`);
      }

      // 3. Monitor movement and errors
      let moveDuration = 0;

      const monitorMovement = () =>
        new Promise((resolve, reject) => {
          const timer = setInterval(async () => {
            moveDuration += CHECK_MOVE_INTERVAL;

            // Check for lifter error signal
            const hasError = plcManager.getValue(plcId, 'LIFTER_1_ERROR');
            if (hasError) {
              clearInterval(timer);
              return reject(new Error('Lifter encountered an error during movement!'));
            }

            logger.debug(`[LifterService] Moving... (${moveDuration}ms)`);

            if (moveDuration >= MAX_MOVE_TIME) {
              clearInterval(timer);
              resolve();
            }
          }, CHECK_MOVE_INTERVAL);
        });

      await monitorMovement();

      // 4. Update sensor positions and release control (Simulating PLC changes)
      const targetPosTag = targetPhysFloor === 1 ? 'LIFTER_1_POS_F1' : 'LIFTER_1_POS_F2';
      const oldPosTag = targetPhysFloor === 1 ? 'LIFTER_1_POS_F2' : 'LIFTER_1_POS_F1';

      await plcManager.writeValue(plcId, targetPosTag, true);
      await plcManager.writeValue(plcId, oldPosTag, false);
      await plcManager.writeValue(plcId, ctrlTag, false); // Deactivate control command

      logger.info(`[LifterService] Arrived at floor ${targetPhysFloor}. Sensors updated.`);

      return {
        success: true,
        message: `Successfully moved lifter to floor ${targetPhysFloor}`,
        previousFloor: currentPhysFloor,
        currentFloor: targetPhysFloor,
      };
    } catch (error) {
      logger.error(`[LifterService] Error in moveLifterToFloor: ${error.message}`);
      throw error;
    }
  }
}

module.exports = LifterService;
