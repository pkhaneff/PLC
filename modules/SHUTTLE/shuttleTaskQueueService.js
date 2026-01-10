const { logger } = require('../../logger/logger');
const redisClient = require('../../redis/init.redis');
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
    return `${this.TASK_PREFIX}:${taskId}`;
  }

  /**
   * Tạo task ID duy nhất
   * @returns {string} Task ID
   */
  generateTaskId() {
    return `stask_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
        ...taskData
      };

      // Chuyển đổi itemInfo thành JSON string nếu nó là object/array
      if (fullTaskDetails.itemInfo && (typeof fullTaskDetails.itemInfo === 'object' || Array.isArray(fullTaskDetails.itemInfo))) {
        fullTaskDetails.itemInfo = JSON.stringify(fullTaskDetails.itemInfo);
      }

      await redisClient.hSet(this.getTaskKey(taskId), fullTaskDetails);

      // 2. Thêm task vào hàng đợi tổng (Sorted Set với score = timestamp)
      const globalQueueData = {
        taskId,
        pickupNodeQr,
        pickupNodeFloorId, // Include floor ID in global queue data
        endNodeQr,
        timestamp,
        priority: taskData.priority || 0 // Default priority
      };

      await redisClient.zAdd(this.GLOBAL_TASK_QUEUE_KEY, {
        score: timestamp,
        value: JSON.stringify(globalQueueData)
      });

      // Lấy vị trí trong hàng đợi tổng
      const position = await redisClient.zRank(
        this.GLOBAL_TASK_QUEUE_KEY,
        JSON.stringify(globalQueueData)
      );

      console.log(`✓ Shuttle Task ${taskId} registered: ${pickupNodeQr} → ${endNodeQr}, Position: ${position + 1}`);

      return {
        taskId,
        position: position + 1, // +1 vì rank bắt đầu từ 0
        timestamp,
        globalQueueLength: await this.getGlobalQueueLength()
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
      const tasks = await redisClient.zRange(this.GLOBAL_TASK_QUEUE_KEY, 0, 0);

      if (tasks.length === 0) {
        return null;
      }

      const taskSummary = JSON.parse(tasks[0]);
      const taskDetails = await this.getTaskDetails(taskSummary.taskId);

      // Chỉ trả về nếu trạng thái là 'pending'
      if (taskDetails && taskDetails.status === 'pending') {
        // Chuyển đổi lại itemInfo thành object/array
        if (taskDetails.itemInfo && typeof taskDetails.itemInfo === 'string') {
          try { taskDetails.itemInfo = JSON.parse(taskDetails.itemInfo); } catch (e) { /* ignore */ }
        }
        return {
          ...taskSummary,
          ...taskDetails
        };
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
      const tasks = await redisClient.zRange(this.GLOBAL_TASK_QUEUE_KEY, 0, end);

      const fullTasks = await Promise.all(tasks.map(async taskStr => {
        const taskSummary = JSON.parse(taskStr);
        const taskDetails = await this.getTaskDetails(taskSummary.taskId);
        // Chuyển đổi lại itemInfo và externalSignalData thành object
        if (taskDetails && taskDetails.itemInfo && typeof taskDetails.itemInfo === 'string') {
          try { taskDetails.itemInfo = JSON.parse(taskDetails.itemInfo); } catch (e) { /* ignore */ }
        }
        if (taskDetails && taskDetails.externalSignalData && typeof taskDetails.externalSignalData === 'string') {
          try { taskDetails.externalSignalData = JSON.parse(taskDetails.externalSignalData); } catch (e) { /* ignore */ }
        }
        return { ...taskSummary, ...taskDetails };
      }));

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
          try { details.itemInfo = JSON.parse(details.itemInfo); } catch (e) { /* ignore */ }
        }
        return details;
      }
      return null;
    } catch (error) {
      console.error('Error getting shuttle task details:', error);
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

        // IMPORTANT: Remove from the main pending queue to unblock the dispatcher.
        const taskDetails = await redisClient.hGetAll(taskKey);
        if (taskDetails && taskDetails.timestamp) {
          const globalQueueData = {
            taskId: taskDetails.taskId,
            pickupNodeQr: taskDetails.pickupNodeQr,
            pickupNodeFloorId: parseInt(taskDetails.pickupNodeFloorId, 10), // CRITICAL: Convert to number
            endNodeQr: taskDetails.endNodeQr,
            timestamp: parseInt(taskDetails.timestamp, 10),
            priority: parseInt(taskDetails.priority, 10) || 0,
          };
          const valueToRemove = JSON.stringify(globalQueueData);
          const removeResult = await redisClient.zRem(this.GLOBAL_TASK_QUEUE_KEY, valueToRemove);
          if (removeResult > 0) {
            logger.info(`[TaskQueueService] Removed task ${taskId} from global pending queue.`);
          } else {
            logger.warn(`[TaskQueueService] Failed to remove task ${taskId} from global pending queue. JSON may not match.`);
          }
        }

      } else if (status === 'completed') {
        await redisClient.sRem(this.PROCESSING_TASKS_KEY, taskId);
        await redisClient.del(taskKey);
        logger.info(`[TaskQueueService] Task ${taskId} completed and cleared from Redis.`);

      } else if (status === 'failed') {
        await redisClient.sRem(this.PROCESSING_TASKS_KEY, taskId);
        logger.warn(`[TaskQueueService] Task ${taskId} failed. Left details in Redis for inspection.`);
      }

      logger.info(`✓ Shuttle Task ${taskId} status updated to: ${status}`);
      return true;
    } catch (error) {
      logger.error(`Error updating shuttle task ${taskId} status to ${status}:`, error);
      throw error;
    }
  }

  // ...

  /**
   * Xóa một task khỏi tất cả các hàng đợi và chi tiết
   * Chỉ nên gọi khi task đã hoàn thành hoặc thất bại và không cần lưu trữ nữa
   * @param {string} taskId - ID của nhiệm vụ
   * @returns {boolean} Success
   */
  async removeTask(taskId) {
    try {
      // Xóa khỏi processing tasks set
      await redisClient.sRem(this.PROCESSING_TASKS_KEY, taskId);

      // Lấy thông tin task để xóa khỏi global_task_queue (cần JSON string gốc)
      const taskDetails = await this.getTaskDetails(taskId);
      if (taskDetails) {
        // Un-reserve logic removed as per original file...

        const globalQueueData = {
          taskId: taskDetails.taskId,
          pickupNodeQr: taskDetails.pickupNodeQr,
          pickupNodeFloorId: parseInt(taskDetails.pickupNodeFloorId, 10), // Convert to number
          endNodeQr: taskDetails.endNodeQr,
          timestamp: parseInt(taskDetails.timestamp, 10), // Convert to number
          priority: parseInt(taskDetails.priority, 10) || 0
        };
        await redisClient.zRem(this.GLOBAL_TASK_QUEUE_KEY, JSON.stringify(globalQueueData));
      }

      // Xóa task details hash
      await redisClient.del(this.getTaskKey(taskId));

      console.log(`✓ Shuttle Task ${taskId} removed from all queues and details`);
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
      const taskKeys = await redisClient.keys(`${this.TASK_PREFIX}:*`);
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
