const redisClient = require('../../redis/init.redis');
const { logger } = require('../../logger/logger');

/**
 * A generic service for acquiring and releasing distributed locks using Redis.
 * This is used to reserve resources like endNodes and pickupNodes.
 */
class ReservationService {

  /**
   * Attempts to acquire a lock for a specific resource.
   * 
   * @param {string} resourceKey - The unique key for the resource to lock (e.g., 'endnode:lock:123').
   * @param {string} ownerId - An identifier for who owns the lock (e.g., a taskId).
   * @param {number} timeout - The lock's expiration time in seconds.
   * @returns {Promise<boolean>} A promise that resolves to true if the lock was acquired, false otherwise.
   */
  async acquireLock(resourceKey, ownerId, timeout) {
    try {
      const result = await redisClient.set(resourceKey, ownerId, {
        NX: true, // Only set if the key does not already exist
        EX: timeout, // Set an expiration time
      });

      if (result === 'OK') {
        logger.debug(`[ReservationService] Lock acquired for resource: ${resourceKey}`);
        return true;
      }
      logger.debug(`[ReservationService] Failed to acquire lock, resource already locked: ${resourceKey}`);
      return false;
    } catch (error) {
      logger.error(`[ReservationService] Error acquiring lock for resource ${resourceKey}:`, error);
      throw error;
    }
  }

  /**
   * Releases a lock for a specific resource.
   * 
   * @param {string} resourceKey - The unique key for the resource to unlock.
   * @returns {Promise<boolean>} A promise that resolves to true if the lock was released, false otherwise.
   */
  async releaseLock(resourceKey) {
    try {
      const result = await redisClient.del(resourceKey);
      if (result > 0) {
        return true;
      }
      logger.warn(`[ReservationService] Attempted to release a lock that did not exist or already expired: ${resourceKey}`);
      return false;
    } catch (error) {
      logger.error(`[ReservationService] Error releasing lock for resource ${resourceKey}:`, error);
      throw error;
    }
  }

  /**
   * Retrieves the owner of a lock.
   *
   * @param {string} resourceKey - The unique key for the resource.
   * @returns {Promise<string|null>} A promise that resolves to the ownerId if the lock exists, null otherwise.
   */
  async getLockOwner(resourceKey) {
    try {
      const ownerId = await redisClient.get(resourceKey);
      return ownerId;
    } catch (error) {
      logger.error(`[ReservationService] Error getting lock owner for resource ${resourceKey}:`, error);
      throw error;
    }
  }
}

module.exports = new ReservationService();