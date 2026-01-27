const { logger } = require('../../../logger/logger');
const redisClient = require('../../../redis/init.redis');

/**
 * Service để quản lý shuttles đang trong "execute mode"
 * Execute mode = shuttle đã được kích hoạt qua /execute-storage và tự động lấy tasks từ queue
 */
class ExecutingModeService {
  constructor() {
    this.EXECUTING_SET_KEY = 'shuttle:executing_mode';
  }

  /**
   * Thêm shuttle vào execute mode
   * @param {string} shuttleId - ID của shuttle
   * @returns {Promise<boolean>}
   */
  async addShuttle(shuttleId) {
    try {
      await redisClient.sAdd(this.EXECUTING_SET_KEY, shuttleId);
      logger.info(`[ExecutingModeService] Shuttle ${shuttleId} added to executing mode`);
      return true;
    } catch (error) {
      logger.error(`[ExecutingModeService] Error adding shuttle ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Xóa shuttle khỏi execute mode
   * @param {string} shuttleId - ID của shuttle
   * @returns {Promise<boolean>}
   */
  async removeShuttle(shuttleId) {
    try {
      await redisClient.sRem(this.EXECUTING_SET_KEY, shuttleId);
      logger.info(`[ExecutingModeService] Shuttle ${shuttleId} removed from executing mode`);
      return true;
    } catch (error) {
      logger.error(`[ExecutingModeService] Error removing shuttle ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Kiểm tra shuttle có trong execute mode không
   * @param {string} shuttleId - ID của shuttle
   * @returns {Promise<boolean>}
   */
  async isShuttleExecuting(shuttleId) {
    try {
      const isMember = await redisClient.sIsMember(this.EXECUTING_SET_KEY, shuttleId);
      return isMember;
    } catch (error) {
      logger.error(`[ExecutingModeService] Error checking shuttle ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Lấy tất cả shuttles đang trong execute mode
   * @returns {Promise<string[]>}
   */
  async getExecutingShuttles() {
    try {
      const shuttles = await redisClient.sMembers(this.EXECUTING_SET_KEY);
      return shuttles || [];
    } catch (error) {
      logger.error('[ExecutingModeService] Error getting executing shuttles:', error);
      return [];
    }
  }

  /**
   * Đếm số lượng shuttles đang trong execute mode
   * @returns {Promise<number>}
   */
  async getExecutingCount() {
    try {
      const count = await redisClient.sCard(this.EXECUTING_SET_KEY);
      return count || 0;
    } catch (error) {
      logger.error('[ExecutingModeService] Error counting executing shuttles:', error);
      return 0;
    }
  }

  /**
   * Xóa tất cả shuttles khỏi execute mode (cleanup)
   * @returns {Promise<boolean>}
   */
  async clearAll() {
    try {
      await redisClient.del(this.EXECUTING_SET_KEY);
      logger.info('[ExecutingModeService] Cleared all shuttles from executing mode');
      return true;
    } catch (error) {
      logger.error('[ExecutingModeService] Error clearing executing mode:', error);
      return false;
    }
  }
}

module.exports = new ExecutingModeService();
