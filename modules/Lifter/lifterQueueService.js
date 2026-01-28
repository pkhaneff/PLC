const redisClient = require('../../redis/init.redis');
const { logger } = require('../../config/logger');

/**
 * Service for managing lifter queues using Redis.
 *
 * Redis Structure:
 * 1. Global Queue: lifter:global_queue
 *    - Sorted Set: stores requests for lifter in registration order.
 *    - Score: timestamp (registration time).
 *    - Member: JSON string containing {taskId, fromFloor, toFloor, lifterId, timestamp}.
 *
 * 2. Floor Queue: lifter:floor:{floorId}:queue
 *    - List: stores task IDs for a specific floor in FIFO order.
 *
 * 3. Task Details: lifter:task:{taskId}
 *    - Hash: stores detailed task information.
 */
class LifterQueueService {
  constructor() {
    this._globalQueueKey = 'lifter:global_queue';
    this._floorQueuePrefix = 'lifter:floor';
    this._taskPrefix = 'lifter:task';
    this._processingKey = 'lifter:processing'; // Stores the task being processed
  }

  /**
   * Get Redis key for a floor queue.
   * @param {number} floorId - Floor ID
   * @returns {string} Redis key
   */
  getFloorQueueKey(floorId) {
    return `${this._floorQueuePrefix}:${floorId}:queue`;
  }

  /**
   * Get Redis key for task details.
   * @param {string} taskId - Task ID
   * @returns {string} Redis key
   */
  getTaskKey(taskId) {
    return `${this._taskPrefix}:${taskId}`;
  }

  /**
   * Generate a unique task ID.
   * @returns {string} Task ID
   */
  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Register a new task that requires the lifter.
   * @param {number} fromFloor - Starting floor
   * @param {number} toFloor - Destination floor
   * @param {number} lifterId - Designated lifter ID
   * @param {Object} taskData - Additional task data (shuttleId, etc.)
   * @returns {Object} Registration details
   */
  async registerTask(fromFloor, toFloor, lifterId, taskData = {}) {
    const taskId = this.generateTaskId();
    const timestamp = Date.now();

    try {
      // 1. Save task details to Redis Hash
      const taskDetails = {
        taskId,
        fromFloor,
        toFloor,
        lifterId,
        timestamp,
        status: 'pending',
        ...taskData,
      };

      await redisClient.hSet(this.getTaskKey(taskId), taskDetails);

      // 2. Add task to the starting floor's queue
      await redisClient.rPush(this.getFloorQueueKey(fromFloor), taskId);

      // 3. Add task to the global queue (Sorted Set with score = timestamp)
      const globalQueueData = {
        taskId,
        fromFloor,
        toFloor,
        lifterId,
        timestamp,
      };

      await redisClient.zAdd(this._globalQueueKey, {
        score: timestamp,
        value: JSON.stringify(globalQueueData),
      });

      // Get rank in global queue
      const position = await redisClient.zRank(this._globalQueueKey, JSON.stringify(globalQueueData));

      logger.info(
        `[LifterQueue] Task ${taskId} registered: Floor ${fromFloor} → ${toFloor}, Lifter ${lifterId}, Position: ${position + 1}`,
      );

      return {
        taskId,
        position: position + 1, // +1 because rank is 0-indexed
        timestamp,
        floorQueueLength: await this.getFloorQueueLength(fromFloor),
        globalQueueLength: await this.getGlobalQueueLength(),
      };
    } catch (error) {
      logger.error(`[LifterQueue] Error registering task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get next task from the global queue.
   * @returns {Object|null} Task data or null
   */
  async getNextTask() {
    try {
      const tasks = await redisClient.zRange(this._globalQueueKey, 0, 0);

      if (tasks.length === 0) {
        return null;
      }

      const taskData = JSON.parse(tasks[0]);
      const taskDetails = await redisClient.hGetAll(this.getTaskKey(taskData.taskId));

      return {
        ...taskData,
        ...taskDetails,
      };
    } catch (error) {
      logger.error(`[LifterQueue] Error getting next task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark a task as being processed.
   * @param {string} taskId - Task ID
   * @returns {boolean} Success
   */
  async markTaskAsProcessing(taskId) {
    try {
      await redisClient.hSet(this.getTaskKey(taskId), 'status', 'processing');
      await redisClient.set(this._processingKey, taskId);

      logger.info(`[LifterQueue] Task ${taskId} marked as processing`);
      return true;
    } catch (error) {
      logger.error(`[LifterQueue] Error marking task as processing: ${error.message}`);
      throw error;
    }
  }

  /**
   * Complete a task and remove it from queues.
   * @param {string} taskId - Task ID
   * @returns {Object} Result details
   */
  async completeTask(taskId) {
    try {
      const taskDetails = await redisClient.hGetAll(this.getTaskKey(taskId));

      if (!taskDetails || !taskDetails.fromFloor) {
        throw new Error(`Task ${taskId} not found`);
      }

      const { fromFloor } = taskDetails;

      // 1. Remove from floor queue
      await redisClient.lRem(this.getFloorQueueKey(fromFloor), 1, taskId);

      // 2. Remove from global queue
      const allTasks = await redisClient.zRange(this._globalQueueKey, 0, -1);
      for (const taskStr of allTasks) {
        const task = JSON.parse(taskStr);
        if (task.taskId === taskId) {
          await redisClient.zRem(this._globalQueueKey, taskStr);
          break;
        }
      }

      // 3. Remove task details
      await redisClient.del(this.getTaskKey(taskId));

      // 4. Remove from processing
      const processingTaskId = await redisClient.get(this._processingKey);
      if (processingTaskId === taskId) {
        await redisClient.del(this._processingKey);
      }

      logger.info(`[LifterQueue] Task ${taskId} completed and removed from queues`);

      // 5. Get next task
      const nextTask = await this.getNextTask();

      return {
        success: true,
        completedTask: taskDetails,
        nextTask,
        remainingInGlobalQueue: await this.getGlobalQueueLength(),
        remainingInFloorQueue: await this.getFloorQueueLength(fromFloor),
      };
    } catch (error) {
      logger.error(`[LifterQueue] Error completing task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get length of global queue.
   * @returns {number} Task count
   */
  async getGlobalQueueLength() {
    try {
      return await redisClient.zCard(this._globalQueueKey);
    } catch (error) {
      logger.error(`[LifterQueue] Error getting global queue length: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get length of a floor queue.
   * @param {number} floorId - Floor ID
   * @returns {number} Task count
   */
  async getFloorQueueLength(floorId) {
    try {
      return await redisClient.lLen(this.getFloorQueueKey(floorId));
    } catch (error) {
      logger.error(`[LifterQueue] Error getting floor queue length: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get all task IDs in a floor queue.
   * @param {number} floorId - Floor ID
   * @returns {Array} List of task IDs
   */
  async getFloorQueue(floorId) {
    try {
      return await redisClient.lRange(this.getFloorQueueKey(floorId), 0, -1);
    } catch (error) {
      logger.error(`[LifterQueue] Error getting floor queue: ${error.message}`);
      return [];
    }
  }

  /**
   * Get tasks in global queue.
   * @param {number} limit - Max tasks to return (0 = all)
   * @returns {Array} List of tasks
   */
  async getGlobalQueue(limit = 0) {
    try {
      const end = limit > 0 ? limit - 1 : -1;
      const tasks = await redisClient.zRange(this._globalQueueKey, 0, end);

      return tasks.map((taskStr) => JSON.parse(taskStr));
    } catch (error) {
      logger.error(`[LifterQueue] Error getting global queue: ${error.message}`);
      return [];
    }
  }

  /**
   * Get task details by ID.
   * @param {string} taskId - Task ID
   * @returns {Object|null} Task details
   */
  async getTaskDetails(taskId) {
    try {
      const details = await redisClient.hGetAll(this.getTaskKey(taskId));
      return Object.keys(details).length > 0 ? details : null;
    } catch (error) {
      logger.error(`[LifterQueue] Error getting task details: ${error.message}`);
      return null;
    }
  }

  /**
   * Get current processing task.
   * @returns {Object|null} Task details
   */
  async getCurrentProcessingTask() {
    try {
      const taskId = await redisClient.get(this._processingKey);
      if (!taskId) {
        return null;
      }

      return await this.getTaskDetails(taskId);
    } catch (error) {
      logger.error(`[LifterQueue] Error getting current processing task: ${error.message}`);
      return null;
    }
  }

  /**
   * Clear all queues.
   * @returns {boolean} Success
   */
  async clearAllQueues() {
    try {
      const keys = await redisClient.keys(`${this._floorQueuePrefix}:*`);

      await redisClient.del(this._globalQueueKey);
      await redisClient.del(this._processingKey);

      if (keys.length > 0) {
        await redisClient.del(keys);
      }

      const taskKeys = await redisClient.keys(`${this._taskPrefix}:*`);
      if (taskKeys.length > 0) {
        await redisClient.del(taskKeys);
      }

      logger.info('[LifterQueue] All queues cleared');
      return true;
    } catch (error) {
      logger.error(`[LifterQueue] Error clearing queues: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get queue statistics.
   * @returns {Object} Stats object
   */
  async getQueueStats() {
    try {
      const globalLength = await this.getGlobalQueueLength();
      const processingTask = await this.getCurrentProcessingTask();

      const floorStats = {};
      const floorKeys = await redisClient.keys(`${this._floorQueuePrefix}:*:queue`);

      for (const key of floorKeys) {
        const floorId = key.split(':')[2];
        floorStats[floorId] = await this.getFloorQueueLength(floorId);
      }

      return {
        globalQueueLength: globalLength,
        processingTask: processingTask ? processingTask.taskId : null,
        floorQueues: floorStats,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error(`[LifterQueue] Error getting queue stats: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new LifterQueueService();
