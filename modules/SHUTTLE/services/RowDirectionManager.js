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
 * Service to manage direction lock for each row.
 * Ensures all shuttles in the same row move in the same direction (one-way traffic).
 */
class RowDirectionManager {
  constructor() {
    this._lockTTL = 300; // 5 minutes in seconds
    this._cleanupInterval = 60000; // 1 minute in milliseconds

    // Start cleanup job
    this._startCleanupJob();
  }

  /**
   * Create Redis key for row direction lock.
   */
  _getRowKey(floorId, rowIdentifier) {
    return `row:${floorId}:${rowIdentifier}:direction`;
  }

  /**
   * Lock direction for a row.
   * @param {string|number} rowIdentifier - Row identifier (e.g., 5, "B")
   * @param {number} floorId - Floor ID
   * @param {number} direction - Direction code (1=LEFT_TO_RIGHT, 2=RIGHT_TO_LEFT)
   * @param {string} shuttleId - Shuttle ID
   * @returns {Promise<boolean>} True if lock successful
   */
  async lockRowDirection(rowIdentifier, floorId, direction, shuttleId) {
    try {
      const key = this._getRowKey(floorId, rowIdentifier);
      const existingLock = await redisClient.get(key);

      if (!existingLock) {
        // Row has no direction lock, create new one
        const lockData = {
          direction,
          shuttles: [shuttleId],
          lockedAt: Date.now(),
          lockedBy: shuttleId,
        };

        await redisClient.set(key, JSON.stringify(lockData), { EX: this._lockTTL });
        logger.info(
          `[RowDirectionManager] Locked row ${rowIdentifier} (floor ${floorId}) with direction ${direction} for shuttle ${shuttleId}`,
        );
        return true;
      }

      // Row already has a lock
      const lock = JSON.parse(existingLock);

      if (lock.direction === direction) {
        // Same direction, allow shuttle to join
        if (!lock.shuttles.includes(shuttleId)) {
          lock.shuttles.push(shuttleId);
          await redisClient.set(key, JSON.stringify(lock), { EX: this._lockTTL });
          logger.debug(
            `[RowDirectionManager] Shuttle ${shuttleId} joined row ${rowIdentifier} (direction ${direction})`,
          );
        }
        return true;
      } else {
        // Different direction, deny access
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
   * Release shuttle from row direction lock.
   */
  async releaseShuttleFromRow(rowIdentifier, floorId, shuttleId) {
    try {
      const key = this._getRowKey(floorId, rowIdentifier);
      const existingLock = await redisClient.get(key);

      if (!existingLock) {
        return;
      }

      const lock = JSON.parse(existingLock);
      lock.shuttles = lock.shuttles.filter((id) => id !== shuttleId);

      if (lock.shuttles.length === 0) {
        // No more shuttles, delete the lock
        await redisClient.del(key);
        logger.info(
          `[RowDirectionManager] Row ${rowIdentifier} (floor ${floorId}) direction lock released (no shuttles left)`,
        );
      } else {
        // Other shuttles remain, update the lock
        await redisClient.set(key, JSON.stringify(lock), { EX: this._lockTTL });
      }
    } catch (error) {
      logger.error(`[RowDirectionManager] Error releasing shuttle from row:`, error);
    }
  }

  /**
   * Clear direction lock for row (e.g., when row is full).
   */
  async clearRowDirectionLock(rowIdentifier, floorId) {
    try {
      const key = this._getRowKey(floorId, rowIdentifier);
      await redisClient.del(key);
      logger.info(`[RowDirectionManager] Cleared direction lock for row ${rowIdentifier} (floor ${floorId})`);
    } catch (error) {
      logger.error(`[RowDirectionManager] Error clearing row direction lock:`, error);
    }
  }

  /**
   * Get current direction of the row.
   * @returns {Promise<number|null>} Direction code or null
   */
  async getRowDirection(rowIdentifier, floorId) {
    try {
      const key = this._getRowKey(floorId, rowIdentifier);
      const lock = await redisClient.get(key);
      return lock ? JSON.parse(lock).direction : null;
    } catch (error) {
      logger.error(`[RowDirectionManager] Error getting row direction:`, error);
      return null;
    }
  }

  /**
   * Cleanup stale locks (run periodically).
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

        // If lock is older than 10 minutes, remove it (shuttle might have crashed)
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
   * Start cleanup job.
   */
  _startCleanupJob() {
    setInterval(() => {
      this.cleanupStaleLocks();
    }, this._cleanupInterval);
  }
}

module.exports = new RowDirectionManager();
module.exports.DIRECTION = DIRECTION;
