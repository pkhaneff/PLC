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
  async registerTask(taskData) {
    const taskId = this.generateTaskId();
    const timestamp = Date.now();
    logger.debug('[TaskQueueService] Registering task with data:', JSON.stringify(taskData)); // DEBUG LOG POINT 2 - Force stringify

    try {
      // Đảm bảo các trường cần thiết có mặt
      const { pickupNode, pickupNodeFloorId, endNode } = taskData;
      if (!pickupNode || !pickupNodeFloorId || !endNode) {
        throw new Error('Shuttle task must have pickupNode, pickupNodeFloorId, and endNode');
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
      // externalSignalData is no longer expected

      await redisClient.hSet(this.getTaskKey(taskId), fullTaskDetails);

      // 2. Thêm task vào hàng đợi tổng (Sorted Set với score = timestamp)
      const globalQueueData = {
        taskId,
        pickupNode,
        pickupNodeFloorId, // Include floor ID in global queue data
        endNode,
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

      console.log(`✓ Shuttle Task ${taskId} registered: ${pickupNode} → ${endNode}, Position: ${position + 1}`);

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
        // Nếu task đầu tiên không pending (đã assigned/in_progress nhưng chưa xóa khỏi global_task_queue),
        // chúng ta sẽ cần một cơ chế để bỏ qua nó hoặc xóa nó nếu nó đã được xử lý xong
        // Tạm thời, để đơn giản, chỉ lấy task pending
        // Cần xem xét lại: nếu task đầu tiên không pending, có thể có các task pending khác phía sau
        // Một cách tốt hơn là duyệt qua một vài task đầu tiên hoặc chỉ lấy những task có status pending trong sorted set.
        // Tuy nhiên, Redis sorted set không hỗ trợ query theo field của member JSON string.
        // Tạm thời, tôi sẽ để như vậy, và hệ thống điều phối sẽ chỉ lấy task pending từ đây.
        // Nếu task đầu tiên không pending, nó sẽ cần tìm task pending tiếp theo.
        // Để giải quyết triệt để, có thể phải dùng thêm một Sorted Set khác chỉ chứa pending tasks.
        // Hoặc khi markTaskAsAssigned, remove nó khỏi global_task_queue, chỉ giữ task ID trong processing_tasks
        return null; // Tạm thời, nếu task đầu tiên không pending, coi như không có task pending
      }

    } catch (error) {
      console.error('Error getting next pending shuttle task:', error);
      throw error;
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
            pickupNode: taskDetails.pickupNode,
            pickupNodeFloorId: parseInt(taskDetails.pickupNodeFloorId, 10), // CRITICAL: Convert to number
            endNode: taskDetails.endNode,
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
        // On completion, remove from processing set AND delete the task hash
        await redisClient.sRem(this.PROCESSING_TASKS_KEY, taskId);
        await redisClient.del(taskKey);
        logger.info(`[TaskQueueService] Task ${taskId} completed and cleared from Redis.`);

      } else if (status === 'failed') {
        // On failure, only remove from the processing set, leaving the hash for inspection
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
        // Un-reserve the cell associated with this task
        if (taskDetails.endNode && taskDetails.endNodeFloorId) {
          const cell = await cellService.getCellByQrCode(taskDetails.endNode, taskDetails.endNodeFloorId);
          if (cell) {
            // Note: In the new architecture, endNode reservation is a Redis lock, not a DB field.
            // This unreserveCell call (which updates DB) might be obsolete or need re-evaluation.
            // For now, removing it as it conflicts with the 'DB only reflects reality' principle.
            // await cellService.unreserveCell(cell.id);
            logger.info(`[TaskQueueService] Not attempting to unreserve DB cell ${cell.id} for removed task ${taskId} (logic moved to ReservationService).`);
          }
        }

        const globalQueueData = {
          taskId: taskDetails.taskId,
          pickupNode: taskDetails.pickupNode,
          pickupNodeFloorId: parseInt(taskDetails.pickupNodeFloorId, 10), // Convert to number
          endNode: taskDetails.endNode,
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
