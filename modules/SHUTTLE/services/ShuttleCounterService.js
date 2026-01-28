const { logger } = require('../../../config/logger');
const { getAllShuttleStates } = require('./shuttleStateCache');
const redisClient = require('../../../redis/init.redis');
const { SHUTTLE_STATUS } = require('../../../config/shuttle.config');

/**
 * Service để đếm số lượng shuttle đang active (không IDLE)
 * Dùng để quyết định bật/tắt one-way traffic mode
 */
class ShuttleCounterService {
  constructor() {
    this.COUNTER_KEY = 'system:active_shuttle_count';
    this.COUNTER_TTL = 10; // 10 giây
  }

  /**
   * Đếm số shuttle đang trong executing mode (được kích hoạt qua /execute-storage)
   * Chỉ đếm shuttles trong executing mode, không phải tất cả active shuttles
   * @returns {Promise<number>} Số lượng shuttle trong executing mode
   */
  async getActiveShuttleCount() {
    try {
      const ExecutingModeService = require('./ExecutingModeService');
      const count = await ExecutingModeService.getExecutingCount();

      // Cache vào Redis
      await redisClient.set(this.COUNTER_KEY, count.toString(), { EX: this.COUNTER_TTL });

      logger.debug(`[ShuttleCounterService] Executing shuttle count: ${count}`);
      return count;
    } catch (error) {
      logger.error('[ShuttleCounterService] Error counting executing shuttles:', error);
      return 0;
    }
  }

  /**
   * Lấy counter từ cache (nếu có), nếu không thì tính lại
   * @returns {Promise<number>}
   */
  async getCount() {
    try {
      const cached = await redisClient.get(this.COUNTER_KEY);
      if (cached !== null) {
        return parseInt(cached, 10);
      }

      // Cache miss, tính lại
      return await this.getActiveShuttleCount();
    } catch (error) {
      logger.error('[ShuttleCounterService] Error getting count:', error);
      return 0;
    }
  }

  /**
   * Update counter (gọi sau mỗi sự kiện dispatch hoặc complete)
   * @returns {Promise<number>}
   */
  async updateCounter() {
    return await this.getActiveShuttleCount();
  }

  /**
   * Kiểm tra xem có nên enable one-way mode không
   * @returns {Promise<boolean>}
   */
  async shouldEnableOneWayMode() {
    const count = await this.getCount();
    return count >= 2;
  }
}

module.exports = new ShuttleCounterService();
