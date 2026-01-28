const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');

/**
 * Service to count the number of active shuttles (not IDLE).
 * Used to decide whether to enable/disable one-way traffic mode.
 */
class ShuttleCounterService {
  constructor() {
    this._counterKey = 'system:active_shuttle_count';
    this._counterTTL = 10; // 10 seconds
  }

  /**
   * Count shuttles in executing mode (activated via /execute-storage).
   * Only counts shuttles in executing mode, not all active shuttles.
   * @returns {Promise<number>} Number of shuttles in executing mode
   */
  async getActiveShuttleCount() {
    try {
      const ExecutingModeService = require('./ExecutingModeService');
      const count = await ExecutingModeService.getExecutingCount();

      // Cache in Redis
      await redisClient.set(this._counterKey, count.toString(), { EX: this._counterTTL });

      logger.debug(`[ShuttleCounterService] Executing shuttle count: ${count}`);
      return count;
    } catch (error) {
      logger.error('[ShuttleCounterService] Error counting executing shuttles:', error);
      return 0;
    }
  }

  /**
   * Get counter from cache (if available), otherwise recalculate.
   * @returns {Promise<number>}
   */
  async getCount() {
    try {
      const cached = await redisClient.get(this._counterKey);
      if (cached !== null) {
        return parseInt(cached, 10);
      }

      // Cache miss, recalculate
      return await this.getActiveShuttleCount();
    } catch (error) {
      logger.error('[ShuttleCounterService] Error getting count:', error);
      return 0;
    }
  }

  /**
   * Update counter (call after each dispatch or complete event).
   * @returns {Promise<number>}
   */
  async updateCounter() {
    return await this.getActiveShuttleCount();
  }

  /**
   * Check if one-way mode should be enabled.
   * @returns {Promise<boolean>}
   */
  async shouldEnableOneWayMode() {
    const count = await this.getCount();
    return count >= 2;
  }
}

module.exports = new ShuttleCounterService();
