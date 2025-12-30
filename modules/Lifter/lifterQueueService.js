const redisClient = require('../../redis/init.redis');

/**
 * Service quản lý hàng đợi lifter sử dụng Redis
 *
 * Cấu trúc Redis:
 * 1. Hàng đợi tổng (global queue): lifter:global_queue
 *    - Sorted Set: lưu yêu cầu sử dụng lifter theo thứ tự đăng ký
 *    - Score: timestamp (thời gian đăng ký)
 *    - Member: JSON string chứa {taskId, fromFloor, toFloor, lifterId, timestamp}
 *
 * 2. Hàng đợi từng tầng: lifter:floor:{floorId}:queue
 *    - List: lưu danh sách task IDs của tầng đó theo thứ tự FIFO
 *
 * 3. Task details: lifter:task:{taskId}
 *    - Hash: lưu chi tiết nhiệm vụ
 */
class LifterQueueService {
  constructor() {
    this.GLOBAL_QUEUE_KEY = 'lifter:global_queue';
    this.FLOOR_QUEUE_PREFIX = 'lifter:floor';
    this.TASK_PREFIX = 'lifter:task';
    this.PROCESSING_KEY = 'lifter:processing'; // Lưu task đang xử lý
  }

  /**
   * Tạo key cho hàng đợi của một tầng
   * @param {number} floorId - ID của tầng
   * @returns {string} Redis key
   */
  getFloorQueueKey(floorId) {
    return `${this.FLOOR_QUEUE_PREFIX}:${floorId}:queue`;
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
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Đăng ký một nhiệm vụ mới cần sử dụng lifter
   * @param {number} fromFloor - Tầng xuất phát
   * @param {number} toFloor - Tầng đích
   * @param {number} lifterId - ID của lifter được chỉ định
   * @param {Object} taskData - Dữ liệu bổ sung của nhiệm vụ (shuttleId, etc.)
   * @returns {Object} { taskId, position, timestamp }
   */
  async registerTask(fromFloor, toFloor, lifterId, taskData = {}) {
    const taskId = this.generateTaskId();
    const timestamp = Date.now();

    try {
      // 1. Lưu chi tiết task vào Redis Hash
      const taskDetails = {
        taskId,
        fromFloor,
        toFloor,
        lifterId,
        timestamp,
        status: 'pending',
        ...taskData
      };

      await redisClient.hSet(this.getTaskKey(taskId), taskDetails);

      // 2. Thêm task vào hàng đợi của tầng xuất phát
      await redisClient.rPush(
        this.getFloorQueueKey(fromFloor),
        taskId
      );

      // 3. Thêm yêu cầu vào hàng đợi tổng (Sorted Set với score = timestamp)
      const globalQueueData = {
        taskId,
        fromFloor,
        toFloor,
        lifterId,
        timestamp
      };

      await redisClient.zAdd(this.GLOBAL_QUEUE_KEY, {
        score: timestamp,
        value: JSON.stringify(globalQueueData)
      });

      // Lấy vị trí trong hàng đợi tổng
      const position = await redisClient.zRank(
        this.GLOBAL_QUEUE_KEY,
        JSON.stringify(globalQueueData)
      );

      console.log(`✓ Task ${taskId} registered: Floor ${fromFloor} → ${toFloor}, Lifter ${lifterId}, Position: ${position + 1}`);

      return {
        taskId,
        position: position + 1, // +1 vì rank bắt đầu từ 0
        timestamp,
        floorQueueLength: await this.getFloorQueueLength(fromFloor),
        globalQueueLength: await this.getGlobalQueueLength()
      };
    } catch (error) {
      console.error('Error registering task:', error);
      throw error;
    }
  }

  /**
   * Lấy nhiệm vụ tiếp theo từ hàng đợi tổng
   * @returns {Object|null} Task data hoặc null nếu không có task
   */
  async getNextTask() {
    try {
      // Lấy task đầu tiên trong sorted set (score thấp nhất = đăng ký sớm nhất)
      const tasks = await redisClient.zRange(this.GLOBAL_QUEUE_KEY, 0, 0);

      if (tasks.length === 0) {
        return null;
      }

      const taskData = JSON.parse(tasks[0]);

      // Lấy chi tiết task từ Redis Hash
      const taskDetails = await redisClient.hGetAll(this.getTaskKey(taskData.taskId));

      return {
        ...taskData,
        ...taskDetails
      };
    } catch (error) {
      console.error('Error getting next task:', error);
      throw error;
    }
  }

  /**
   * Đánh dấu task đang được xử lý
   * @param {string} taskId - ID của task
   * @returns {boolean} Success
   */
  async markTaskAsProcessing(taskId) {
    try {
      // Cập nhật status trong task details
      await redisClient.hSet(this.getTaskKey(taskId), 'status', 'processing');

      // Lưu vào processing set
      await redisClient.set(this.PROCESSING_KEY, taskId);

      console.log(`✓ Task ${taskId} marked as processing`);
      return true;
    } catch (error) {
      console.error('Error marking task as processing:', error);
      throw error;
    }
  }

  /**
   * Hoàn thành một nhiệm vụ và xóa khỏi hàng đợi
   * @param {string} taskId - ID của nhiệm vụ
   * @returns {Object} { success, nextTask }
   */
  async completeTask(taskId) {
    try {
      // Lấy thông tin task trước khi xóa
      const taskDetails = await redisClient.hGetAll(this.getTaskKey(taskId));

      if (!taskDetails || !taskDetails.fromFloor) {
        throw new Error(`Task ${taskId} not found`);
      }

      const { fromFloor } = taskDetails;

      // 1. Xóa task khỏi hàng đợi tầng
      await redisClient.lRem(this.getFloorQueueKey(fromFloor), 1, taskId);

      // 2. Xóa task khỏi hàng đợi tổng
      // Tìm và xóa task trong sorted set
      const allTasks = await redisClient.zRange(this.GLOBAL_QUEUE_KEY, 0, -1);
      for (const taskStr of allTasks) {
        const task = JSON.parse(taskStr);
        if (task.taskId === taskId) {
          await redisClient.zRem(this.GLOBAL_QUEUE_KEY, taskStr);
          break;
        }
      }

      // 3. Xóa task details
      await redisClient.del(this.getTaskKey(taskId));

      // 4. Xóa khỏi processing
      const processingTaskId = await redisClient.get(this.PROCESSING_KEY);
      if (processingTaskId === taskId) {
        await redisClient.del(this.PROCESSING_KEY);
      }

      console.log(`✓ Task ${taskId} completed and removed from queues`);

      // 5. Lấy task tiếp theo
      const nextTask = await this.getNextTask();

      return {
        success: true,
        completedTask: taskDetails,
        nextTask,
        remainingInGlobalQueue: await this.getGlobalQueueLength(),
        remainingInFloorQueue: await this.getFloorQueueLength(fromFloor)
      };
    } catch (error) {
      console.error('Error completing task:', error);
      throw error;
    }
  }

  /**
   * Lấy độ dài hàng đợi tổng
   * @returns {number} Số lượng tasks
   */
  async getGlobalQueueLength() {
    try {
      return await redisClient.zCard(this.GLOBAL_QUEUE_KEY);
    } catch (error) {
      console.error('Error getting global queue length:', error);
      return 0;
    }
  }

  /**
   * Lấy độ dài hàng đợi của một tầng
   * @param {number} floorId - ID của tầng
   * @returns {number} Số lượng tasks
   */
  async getFloorQueueLength(floorId) {
    try {
      return await redisClient.lLen(this.getFloorQueueKey(floorId));
    } catch (error) {
      console.error('Error getting floor queue length:', error);
      return 0;
    }
  }

  /**
   * Lấy tất cả tasks trong hàng đợi của một tầng
   * @param {number} floorId - ID của tầng
   * @returns {Array} Mảng task IDs
   */
  async getFloorQueue(floorId) {
    try {
      return await redisClient.lRange(this.getFloorQueueKey(floorId), 0, -1);
    } catch (error) {
      console.error('Error getting floor queue:', error);
      return [];
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
      const tasks = await redisClient.zRange(this.GLOBAL_QUEUE_KEY, 0, end);

      return tasks.map(taskStr => JSON.parse(taskStr));
    } catch (error) {
      console.error('Error getting global queue:', error);
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
      return Object.keys(details).length > 0 ? details : null;
    } catch (error) {
      console.error('Error getting task details:', error);
      return null;
    }
  }

  /**
   * Lấy task đang được xử lý
   * @returns {Object|null} Task details
   */
  async getCurrentProcessingTask() {
    try {
      const taskId = await redisClient.get(this.PROCESSING_KEY);
      if (!taskId) return null;

      return await this.getTaskDetails(taskId);
    } catch (error) {
      console.error('Error getting current processing task:', error);
      return null;
    }
  }

  /**
   * Xóa toàn bộ hàng đợi (dùng cho testing/reset)
   * @returns {boolean} Success
   */
  async clearAllQueues() {
    try {
      // Lấy tất cả floor queue keys
      const keys = await redisClient.keys(`${this.FLOOR_QUEUE_PREFIX}:*`);

      // Xóa global queue
      await redisClient.del(this.GLOBAL_QUEUE_KEY);

      // Xóa processing key
      await redisClient.del(this.PROCESSING_KEY);

      // Xóa tất cả floor queues
      if (keys.length > 0) {
        await redisClient.del(keys);
      }

      // Xóa tất cả task details
      const taskKeys = await redisClient.keys(`${this.TASK_PREFIX}:*`);
      if (taskKeys.length > 0) {
        await redisClient.del(taskKeys);
      }

      console.log('✓ All queues cleared');
      return true;
    } catch (error) {
      console.error('Error clearing queues:', error);
      throw error;
    }
  }

  /**
   * Lấy thống kê hàng đợi
   * @returns {Object} Queue statistics
   */
  async getQueueStats() {
    try {
      const globalLength = await this.getGlobalQueueLength();
      const processingTask = await this.getCurrentProcessingTask();

      // Lấy thống kê từng tầng
      const floorStats = {};
      const floorKeys = await redisClient.keys(`${this.FLOOR_QUEUE_PREFIX}:*:queue`);

      for (const key of floorKeys) {
        const floorId = key.split(':')[2];
        floorStats[floorId] = await this.getFloorQueueLength(floorId);
      }

      return {
        globalQueueLength: globalLength,
        processingTask: processingTask ? processingTask.taskId : null,
        floorQueues: floorStats,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Error getting queue stats:', error);
      throw error;
    }
  }
}

module.exports = new LifterQueueService();
