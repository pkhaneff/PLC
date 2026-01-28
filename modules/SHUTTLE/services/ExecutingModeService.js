const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');

/**
 * Service to manage shuttles in "execute mode"
 * Execute mode = shuttle has been activated via /execute-storage and automatically retrieves tasks from queue
 */
class ExecutingModeService {
  constructor() {
    this._executingSetKey = 'shuttle:executing_mode';
  }

  /**
   * Add shuttle to execute mode
   * @param {string} shuttleId - ID of the shuttle
   * @returns {Promise<boolean>}
   */
  async addShuttle(shuttleId) {
    try {
      await redisClient.sAdd(this._executingSetKey, shuttleId);
      logger.info(`[ExecutingModeService] Shuttle ${shuttleId} added to executing mode`);
      return true;
    } catch (error) {
      logger.error(`[ExecutingModeService] Error adding shuttle ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Remove shuttle from execute mode
   * @param {string} shuttleId - ID of the shuttle
   * @returns {Promise<boolean>}
   */
  async removeShuttle(shuttleId) {
    try {
      await redisClient.sRem(this._executingSetKey, shuttleId);
      logger.info(`[ExecutingModeService] Shuttle ${shuttleId} removed from executing mode`);
      return true;
    } catch (error) {
      logger.error(`[ExecutingModeService] Error removing shuttle ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Check if shuttle is in execute mode
   * @param {string} shuttleId - ID of the shuttle
   * @returns {Promise<boolean>}
   */
  async isShuttleExecuting(shuttleId) {
    try {
      const isMember = await redisClient.sIsMember(this._executingSetKey, shuttleId);
      return isMember;
    } catch (error) {
      logger.error(`[ExecutingModeService] Error checking shuttle ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Get all shuttles in execute mode
   * @returns {Promise<string[]>}
   */
  async getExecutingShuttles() {
    try {
      const shuttles = await redisClient.sMembers(this._executingSetKey);
      return shuttles || [];
    } catch (error) {
      logger.error('[ExecutingModeService] Error getting executing shuttles:', error);
      return [];
    }
  }

  /**
   * Count the number of shuttles in execute mode
   * @returns {Promise<number>}
   */
  async getExecutingCount() {
    try {
      const count = await redisClient.sCard(this._executingSetKey);
      return count || 0;
    } catch (error) {
      logger.error('[ExecutingModeService] Error counting executing shuttles:', error);
      return 0;
    }
  }

  /**
   * Remove all shuttles from execute mode (cleanup)
   * @returns {Promise<boolean>}
   */
  async clearAll() {
    try {
      await redisClient.del(this._executingSetKey);
      logger.info('[ExecutingModeService] Cleared all shuttles from executing mode');
      return true;
    } catch (error) {
      logger.error('[ExecutingModeService] Error clearing executing mode:', error);
      return false;
    }
  }
}

module.exports = new ExecutingModeService();
