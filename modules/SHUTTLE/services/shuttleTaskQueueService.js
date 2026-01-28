const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');
const cellService = require('./cellService');

/**
 * Service quản lý hàng đợi tác vụ shuttle sử dụng Redis
 *
 * Cấu trúc Redis:
 * 1. Hàng đợi tác vụ tổng (global task queue): shuttle:global_task_queue
 *    - Sorted Set: lưu yêu cầu tác vụ shuttle theo thứ tự đăng ký (FIFO)
 *    - Score: timestamp (thời gian đăng ký)
 *    - Member: JSON string chứa {taskId, pickupNode, endNode, timestamp, priority}
 *
 * 2. Chi tiết tác vụ: shuttle:task:{taskId}
 *    - Hash: lưu chi tiết nhiệm vụ (pickupNode, endNode, itemInfo, assignedShuttleId, status, etc.)
 *
 * 3. Các tác vụ đang xử lý: shuttle:processing_tasks
 *    - Set: lưu trữ các taskId của các tác vụ đang được shuttle xử lý. (Vì nhiều shuttle có thể xử lý đồng thời)
 */
class ShuttleTaskQueueService {
  constructor() {
    this.GLOBAL_TASK_QUEUE_KEY = 'shuttle:global_task_queue';
    this.TASK_PREFIX = 'shuttle:task';
    this.PROCESSING_TASKS_KEY = 'shuttle:processing_tasks';
  }

  /**
   * Tạo key cho task details
   * @param {string} taskId - ID của nhiệm vụ
   * @returns {string} Redis key
   */
  getTaskKey(taskId) {
    return `${this.TASK_PREFIX}:${taskId} `;
  }

  /**
   * Tạo task ID duy nhất
   * @returns {string} Task ID
   */
  generateTaskId() {
    return `stask_${Date.now()}_${Math.random().toString(36).substr(2, 9)} `;
  }

  /**
   * Đăng ký một tác vụ shuttle mới
   * @param {Object} taskData - Dữ liệu của tác vụ (pickupNode, pickupNodeFloorId, endNode, itemInfo (array), priority, etc.)
   * @returns {Object} { taskId, position, timestamp }
   */
  /**
   * Đăng ký một tác vụ shuttle mới
   * @param {Object} taskData - Dữ liệu của tác vụ (pickupNodeQr, pickupNodeFloorId, endNodeQr, itemInfo (array), priority, etc.)
   * @returns {Object} { taskId, position, timestamp }
   */
  async registerTask(taskData) {
    const taskId = this.generateTaskId();
    const timestamp = Date.now();
    logger.debug('[TaskQueueService] Registering task with data:', JSON.stringify(taskData));

    try {
      // Đảm bảo các trường cần thiết có mặt (Updated for QR codes)
      const { pickupNodeQr, pickupNodeFloorId, endNodeQr } = taskData;
      if (!pickupNodeQr || !pickupNodeFloorId || !endNodeQr) {
        throw new Error('Shuttle task must have pickupNodeQr, pickupNodeFloorId, and endNodeQr');
      }

      // 1. Lưu chi tiết task vào Hash
      const fullTaskDetails = {
        taskId,
        timestamp,
        status: 'pending', // Trạng thái ban đầu
        ...taskData,
      };

      // Chuyển đổi itemInfo thành JSON string nếu nó là object/array
      if (
        fullTaskDetails.itemInfo &&
        (typeof fullTaskDetails.itemInfo === 'object' || Array.isArray(fullTaskDetails.itemInfo))
      ) {
        fullTaskDetails.itemInfo = JSON.stringify(fullTaskDetails.itemInfo);
      }

      await redisClient.hSet(this.getTaskKey(taskId), fullTaskDetails);

      // 2. Thêm task vào hàng đợi tổng (Sorted Set với score = timestamp)
      // CRITICAL FIX: Use taskId as value instead of JSON object to avoid matching issues
      await redisClient.zAdd(this.GLOBAL_TASK_QUEUE_KEY, {
        score: timestamp,
        value: taskId, // Simple string, easy to remove later
      });

      // Lấy vị trí trong hàng đợi tổng
      const position = await redisClient.zRank(this.GLOBAL_TASK_QUEUE_KEY, taskId);

      return {
        taskId,
        position: position + 1, // +1 vì rank bắt đầu từ 0
        timestamp,
        globalQueueLength: await this.getGlobalQueueLength(),
      };
    } catch (error) {
      console.error('Error registering shuttle task:', error);
      throw error;
    }
  }

  /**
   * Lấy tác vụ tiếp theo từ hàng đợi tổng (pending task)
   * @returns {Object|null} Task data hoặc null nếu không có task pending nào
   */
  async getNextPendingTask() {
    try {
      // Lấy task đầu tiên trong sorted set (score thấp nhất = đăng ký sớm nhất)
      // FIXED: Now the value is taskId (string), not JSON object
      const tasks = await redisClient.zRange(this.GLOBAL_TASK_QUEUE_KEY, 0, 0);

      if (tasks.length === 0) {
        return null;
      }

      const taskId = tasks[0]; // Direct taskId string
      const taskDetails = await this.getTaskDetails(taskId);

      // Chỉ trả về nếu trạng thái là 'pending'
      if (taskDetails && taskDetails.status === 'pending') {
        // Chuyển đổi lại itemInfo thành object/array
        if (taskDetails.itemInfo && typeof taskDetails.itemInfo === 'string') {
          try {
            taskDetails.itemInfo = JSON.parse(taskDetails.itemInfo);
          } catch (e) {
            /* ignore */
          }
        }
        return taskDetails;
      } else {
        return null;
      }
    } catch (error) {
      console.error('Error getting next pending shuttle task:', error);
      throw error;
    }
  }

  /**
   * Lấy độ dài hàng đợi tác vụ tổng
   * @returns {number} Số lượng tasks
   */
  async getGlobalQueueLength() {
    try {
      return await redisClient.zCard(this.GLOBAL_TASK_QUEUE_KEY);
    } catch (error) {
      console.error('Error getting global shuttle task queue length:', error);
      return 0;
    }
  }

  /**
   * Lấy tất cả tasks trong hàng đợi tổng
   * @param {number} limit - Giới hạn số lượng tasks trả về (0 = all)
   * @returns {Array} Mảng tasks với thông tin đầy đủ
   */
  async getGlobalQueue(limit = 0) {
    try {
      const end = limit > 0 ? limit - 1 : -1;
      // FIXED: Now tasks array contains taskId strings, not JSON objects
      const tasks = await redisClient.zRange(this.GLOBAL_TASK_QUEUE_KEY, 0, end);

      const fullTasks = await Promise.all(
        tasks.map(async (taskId) => {
          const taskDetails = await this.getTaskDetails(taskId);
          // Chuyển đổi lại itemInfo và externalSignalData thành object
          if (taskDetails && taskDetails.itemInfo && typeof taskDetails.itemInfo === 'string') {
            try {
              taskDetails.itemInfo = JSON.parse(taskDetails.itemInfo);
            } catch (e) {
              /* ignore */
            }
          }
          if (taskDetails && taskDetails.externalSignalData && typeof taskDetails.externalSignalData === 'string') {
            try {
              taskDetails.externalSignalData = JSON.parse(taskDetails.externalSignalData);
            } catch (e) {
              /* ignore */
            }
          }
          return taskDetails;
        }),
      );

      return fullTasks;
    } catch (error) {
      console.error('Error getting global shuttle task queue:', error);
      return [];
    }
  }

  /**
   * Lấy thông tin chi tiết của một task
   * @param {string} taskId - ID của task
   * @returns {Object|null} Task details
   */
  async getTaskDetails(taskId) {
    try {
      const details = await redisClient.hGetAll(this.getTaskKey(taskId));
      if (Object.keys(details).length > 0) {
        // Chuyển đổi lại itemInfo thành object/array
        if (details.itemInfo && typeof details.itemInfo === 'string') {
          try {
            details.itemInfo = JSON.parse(details.itemInfo);
          } catch (e) {
            /* ignore */
          }
        }
        return details;
      }
      return null;
    } catch (error) {
      logger.error('Error getting shuttle task details:', error);
      return null;
    }
  }

  /**
   * Get the active task currently assigned to a shuttle.
   * @param {string} shuttleId
   * @returns {Promise<object|null>} Task details or null
   */
  async getShuttleTask(shuttleId) {
    try {
      const taskId = await redisClient.get(`shuttle: active_task:${shuttleId} `);
      if (!taskId) {
        return null;
      }
      return await this.getTaskDetails(taskId);
    } catch (error) {
      logger.error(`Error getting active task for shuttle ${shuttleId}: `, error);
      return null;
    }
  }

  /**
   * Lấy các task đang được xử lý
   * @returns {Array} Mảng task IDs đang được xử lý
   */
  async getProcessingTasks() {
    try {
      return await redisClient.sMembers(this.PROCESSING_TASKS_KEY);
    } catch (error) {
      console.error('Error getting processing shuttle tasks:', error);
      return [];
    }
  }

  /**
   * Cập nhật trạng thái của một tác vụ
   * @param {string} taskId - ID của task
   * @param {string} status - Trạng thái mới ('assigned', 'in_progress', 'completed', 'failed')
   * @param {string} assignedShuttleId - (Optional) ID của shuttle được giao task
   * @returns {boolean} Success
   */
  async updateTaskStatus(taskId, status, assignedShuttleId = null) {
    try {
      const taskKey = this.getTaskKey(taskId);
      const updates = { status, lastUpdated: Date.now() };
      if (assignedShuttleId) {
        updates.assignedShuttleId = assignedShuttleId;
      }
      await redisClient.hSet(taskKey, updates);

      if (status === 'assigned') {
        // Add to the set of tasks currently being processed
        await redisClient.sAdd(this.PROCESSING_TASKS_KEY, taskId);

        // Map shuttle to task
        if (assignedShuttleId) {
          await redisClient.set(`shuttle: active_task:${assignedShuttleId} `, taskId);
        }

        // CRITICAL FIX: Remove from the main pending queue to unblock the dispatcher.
        // Now we can simply use taskId instead of complex JSON matching
        const removeResult = await redisClient.zRem(this.GLOBAL_TASK_QUEUE_KEY, taskId);
        if (removeResult === 0) {
          logger.warn(
            `[TaskQueueService] Failed to remove task ${taskId} from global pending queue.Task may not exist in queue.`,
          );
        }
      } else if (status === 'completed') {
        // Find assigned shuttle to clear mapping
        const taskDetails = await this.getTaskDetails(taskId);
        if (taskDetails && taskDetails.assignedShuttleId) {
          await redisClient.del(`shuttle: active_task:${taskDetails.assignedShuttleId} `);
        }

        await redisClient.sRem(this.PROCESSING_TASKS_KEY, taskId);
        await redisClient.del(taskKey);
      } else if (status === 'failed') {
        const taskDetails = await this.getTaskDetails(taskId);
        if (taskDetails && taskDetails.assignedShuttleId) {
          await redisClient.del(`shuttle: active_task:${taskDetails.assignedShuttleId} `);
        }
        await redisClient.sRem(this.PROCESSING_TASKS_KEY, taskId);
      }

      return true;
    } catch (error) {
      logger.error(`Error updating shuttle task ${taskId} status to ${status}: `, error);
      throw error;
    }
  }

  async removeTask(taskId) {
    try {
      // Xóa khỏi processing tasks set
      await redisClient.sRem(this.PROCESSING_TASKS_KEY, taskId);

      // FIXED: Remove from global queue using simple taskId
      await redisClient.zRem(this.GLOBAL_TASK_QUEUE_KEY, taskId);

      // Xóa task details hash
      await redisClient.del(this.getTaskKey(taskId));

      return true;
    } catch (error) {
      console.error('Error removing shuttle task:', error);
      throw error;
    }
  }

  /**
   * Xóa toàn bộ hàng đợi (dùng cho testing/reset)
   * @returns {boolean} Success
   */
  async clearAllQueues() {
    try {
      // Xóa global task queue
      await redisClient.del(this.GLOBAL_TASK_QUEUE_KEY);
      // Xóa processing tasks set
      await redisClient.del(this.PROCESSING_TASKS_KEY);

      // Xóa tất cả task details (cần phải lấy tất cả keys)
      const taskKeys = await redisClient.keys(`${this.TASK_PREFIX}:* `);
      if (taskKeys.length > 0) {
        await redisClient.del(taskKeys);
      }

      console.log('✓ All shuttle task queues cleared');
      return true;
    } catch (error) {
      console.error('Error clearing shuttle task queues:', error);
      throw error;
    }
  }
}

module.exports = new ShuttleTaskQueueService();
