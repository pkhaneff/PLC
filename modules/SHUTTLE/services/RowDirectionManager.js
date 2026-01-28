const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');

/**
 * Direction codes for one-way traffic in rows
 * 1 = LEFT_TO_RIGHT (traffic moves from lower col to higher col)
 * 2 = RIGHT_TO_LEFT (traffic moves from higher col to lower col)
 */
const DIRECTION = {
  LEFT_TO_RIGHT: 1,
  RIGHT_TO_LEFT: 2,
};

/**
 * Service quản lý direction lock cho mỗi row
 * Đảm bảo tất cả shuttle trong cùng 1 row đi cùng 1 hướng (one-way traffic)
 */
class RowDirectionManager {
  constructor() {
    this.LOCK_TTL = 300; // 5 phút
    this.CLEANUP_INTERVAL = 60000; // 1 phút

    // Start cleanup job
    this.startCleanupJob();
  }

  /**
   * Tạo Redis key cho row direction lock
   */
  getRowKey(floorId, rowIdentifier) {
    return `row:${floorId}:${rowIdentifier}:direction`;
  }

  /**
   * Lock direction cho 1 row
   * @param {string|number} rowIdentifier - Row ID (ví dụ: 5, "B")
   * @param {number} floorId - Floor ID
   * @param {number} direction - Direction code (1=LEFT_TO_RIGHT, 2=RIGHT_TO_LEFT)
   * @param {string} shuttleId - Shuttle ID
   * @returns {Promise<boolean>} True nếu lock thành công
   */
  async lockRowDirection(rowIdentifier, floorId, direction, shuttleId) {
    try {
      const key = this.getRowKey(floorId, rowIdentifier);
      const existingLock = await redisClient.get(key);

      if (!existingLock) {
        // Row chưa có direction lock, tạo mới
        const lockData = {
          direction,
          shuttles: [shuttleId],
          lockedAt: Date.now(),
          lockedBy: shuttleId,
        };

        await redisClient.set(key, JSON.stringify(lockData), { EX: this.LOCK_TTL });
        logger.info(
          `[RowDirectionManager] Locked row ${rowIdentifier} (floor ${floorId}) with direction ${direction} for shuttle ${shuttleId}`,
        );
        return true;
      }

      // Row đã có lock
      const lock = JSON.parse(existingLock);

      if (lock.direction === direction) {
        // Cùng direction, cho phép shuttle vào
        if (!lock.shuttles.includes(shuttleId)) {
          lock.shuttles.push(shuttleId);
          await redisClient.set(key, JSON.stringify(lock), { EX: this.LOCK_TTL });
          logger.debug(
            `[RowDirectionManager] Shuttle ${shuttleId} joined row ${rowIdentifier} (direction ${direction})`,
          );
        }
        return true;
      } else {
        // Khác direction, từ chối
        logger.warn(
          `[RowDirectionManager] Shuttle ${shuttleId} cannot enter row ${rowIdentifier}: direction mismatch (required: ${lock.direction}, requested: ${direction})`,
        );
        return false;
      }
    } catch (error) {
      logger.error(`[RowDirectionManager] Error locking row direction:`, error);
      return false;
    }
  }

  /**
   * Release shuttle khỏi row direction lock
   */
  async releaseShuttleFromRow(rowIdentifier, floorId, shuttleId) {
    try {
      const key = this.getRowKey(floorId, rowIdentifier);
      const existingLock = await redisClient.get(key);

      if (!existingLock) {
        return;
      }

      const lock = JSON.parse(existingLock);
      lock.shuttles = lock.shuttles.filter((id) => id !== shuttleId);

      if (lock.shuttles.length === 0) {
        // Không còn shuttle nào, xóa lock hoàn toàn
        await redisClient.del(key);
        logger.info(
          `[RowDirectionManager] Row ${rowIdentifier} (floor ${floorId}) direction lock released (no shuttles left)`,
        );
      } else {
        // Còn shuttle khác, update lock
        await redisClient.set(key, JSON.stringify(lock), { EX: this.LOCK_TTL });
      }
    } catch (error) {
      logger.error(`[RowDirectionManager] Error releasing shuttle from row:`, error);
    }
  }

  /**
   * Clear direction lock cho row (khi row đầy)
   */
  async clearRowDirectionLock(rowIdentifier, floorId) {
    try {
      const key = this.getRowKey(floorId, rowIdentifier);
      await redisClient.del(key);
      logger.info(`[RowDirectionManager] Cleared direction lock for row ${rowIdentifier} (floor ${floorId})`);
    } catch (error) {
      logger.error(`[RowDirectionManager] Error clearing row direction lock:`, error);
    }
  }

  /**
   * Get current direction của row (nếu có)
   * @returns {Promise<number|null>} Direction code hoặc null
   */
  async getRowDirection(rowIdentifier, floorId) {
    try {
      const key = this.getRowKey(floorId, rowIdentifier);
      const lock = await redisClient.get(key);
      return lock ? JSON.parse(lock).direction : null;
    } catch (error) {
      logger.error(`[RowDirectionManager] Error getting row direction:`, error);
      return null;
    }
  }

  /**
   * Cleanup stale locks (chạy định kỳ)
   */
  async cleanupStaleLocks() {
    try {
      const keys = await redisClient.keys('row:*:direction');

      for (const key of keys) {
        const lock = await redisClient.get(key);
        if (!lock) {
          continue;
        }

        const lockData = JSON.parse(lock);
        const age = Date.now() - lockData.lockedAt;

        // Nếu lock quá 10 phút, xóa đi (shuttle có thể đã crash)
        if (age > 600000) {
          await redisClient.del(key);
          logger.warn(`[RowDirectionManager] Cleaned up stale lock for ${key} (age: ${age}ms)`);
        }
      }
    } catch (error) {
      logger.error(`[RowDirectionManager] Error cleaning up stale locks:`, error);
    }
  }

  /**
   * Start cleanup job
   */
  startCleanupJob() {
    setInterval(() => {
      this.cleanupStaleLocks();
    }, this.CLEANUP_INTERVAL);
  }
}

module.exports = new RowDirectionManager();
module.exports.DIRECTION = DIRECTION;
