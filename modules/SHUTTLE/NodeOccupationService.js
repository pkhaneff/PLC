const { logger } = require('../../logger/logger');
const redisClient = require('../../redis/init.redis');
const cellService = require('./cellService');

/**
 * Service for managing node occupation using Redis.
 *
 * Tracks which shuttle is occupying which node in real-time.
 * This is used for:
 * - Conflict detection
 * - Pathfinding avoidance
 * - Blocking/unblocking nodes as shuttles move
 */
class NodeOccupationService {
  /**
   * Block a node by marking it as occupied by a shuttle.
   *
   * @param {string} nodeQr - QR code of node to block
   * @param {string} shuttleId - ID of shuttle occupying the node
   * @param {number} [ttl=300] - Time to live in seconds (default 5 minutes)
   * @returns {Promise<boolean>} Success status
   */
  async blockNode(nodeQr, shuttleId, ttl = 300) {
    try {
      const key = `node:${nodeQr}:occupied_by`;
      await redisClient.set(key, shuttleId, { EX: ttl });
      const nodeName = await cellService.getDisplayNameWithoutFloor(nodeQr);
      logger.debug(`[NodeOccupation] Node ${nodeName} blocked by shuttle ${shuttleId}`);
      return true;
    } catch (error) {
      const nodeName = await cellService.getDisplayNameWithoutFloor(nodeQr);
      logger.error(`[NodeOccupation] Error blocking node ${nodeName}:`, error);
      return false;
    }
  }

  /**
   * Unblock a node by removing its occupation marker.
   *
   * @param {string} nodeQr - QR code of node to unblock
   * @param {string} shuttleId - ID of shuttle that should be occupying (for validation)
   * @returns {Promise<boolean>} Success status
   */
  async unblockNode(nodeQr, shuttleId) {
    try {
      const key = `node:${nodeQr}:occupied_by`;

      // Validate that this shuttle actually owns the lock
      const currentOccupier = await redisClient.get(key);

      if (currentOccupier && currentOccupier !== shuttleId) {
        const nodeName = await cellService.getDisplayNameWithoutFloor(nodeQr);
        logger.warn(
          `[NodeOccupation] Cannot unblock node ${nodeName}: occupied by ${currentOccupier}, not ${shuttleId}`
        );
        return false;
      }

      await redisClient.del(key);
      const nodeName = await cellService.getDisplayNameWithoutFloor(nodeQr);
      logger.debug(`[NodeOccupation] Node ${nodeName} unblocked by shuttle ${shuttleId}`);
      return true;
    } catch (error) {
      const nodeName = await cellService.getDisplayNameWithoutFloor(nodeQr);
      logger.error(`[NodeOccupation] Error unblocking node ${nodeName}:`, error);
      return false;
    }
  }

  /**
   * Check if a node is occupied.
   *
   * @param {string} nodeQr - QR code of node
   * @returns {Promise<string|null>} Shuttle ID if occupied, null otherwise
   */
  async getNodeOccupier(nodeQr) {
    try {
      const key = `node:${nodeQr}:occupied_by`;
      const occupier = await redisClient.get(key);
      return occupier;
    } catch (error) {
      logger.error(`[NodeOccupation] Error checking node ${nodeQr}:`, error);
      return null;
    }
  }

  /**
   * Check if a node is occupied.
   *
   * @param {string} nodeQr - QR code of node
   * @returns {Promise<boolean>} True if occupied
   */
  async isNodeOccupied(nodeQr) {
    const occupier = await this.getNodeOccupier(nodeQr);
    return !!occupier;
  }

  /**
   * Handle shuttle movement: block new node and unblock old node atomically.
   *
   * This is the main method called when a shuttle moves from A to B:
   * 1. Block node B (new position)
   * 2. Unblock node A (old position)
   *
   * @param {string} shuttleId - ID of shuttle moving
   * @param {string} oldNodeQr - QR code of node shuttle is leaving
   * @param {string} newNodeQr - QR code of node shuttle is entering
   * @returns {Promise<boolean>} Success status
   */
  async handleShuttleMove(shuttleId, oldNodeQr, newNodeQr) {
    try {
      const oldNodeName = oldNodeQr ? await cellService.getDisplayNameWithoutFloor(oldNodeQr) : 'none';
      const newNodeName = await cellService.getDisplayNameWithoutFloor(newNodeQr);
      logger.debug(`[NodeOccupation] Handling move for shuttle ${shuttleId}: ${oldNodeName} -> ${newNodeName}`);

      // Block new node first
      const blocked = await this.blockNode(newNodeQr, shuttleId);
      if (!blocked) {
        logger.error(`[NodeOccupation] Failed to block new node ${newNodeName} for shuttle ${shuttleId}`);
        return false;
      }

      // Unblock old node (if exists)
      if (oldNodeQr) {
        await this.unblockNode(oldNodeQr, shuttleId);
      }

      return true;
    } catch (error) {
      logger.error(`[NodeOccupation] Error handling shuttle move for ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Clear all occupation data for a shuttle (when shuttle completes task or disconnects).
   *
   * @param {string} shuttleId - ID of shuttle
   * @returns {Promise<boolean>} Success status
   */
  async clearShuttleOccupation(shuttleId) {
    try {
      // Find all nodes occupied by this shuttle
      const pattern = 'node:*:occupied_by';
      const keys = await redisClient.keys(pattern);

      let clearedCount = 0;
      for (const key of keys) {
        const occupier = await redisClient.get(key);
        if (occupier === shuttleId) {
          await redisClient.del(key);
          clearedCount++;
        }
      }

      return true;
    } catch (error) {
      logger.error(`[NodeOccupation] Error clearing occupation for shuttle ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Get all occupied nodes.
   *
   * @returns {Promise<object>} Map of nodeQr -> shuttleId
   */
  async getAllOccupiedNodes() {
    try {
      const pattern = 'node:*:occupied_by';
      const keys = await redisClient.keys(pattern);

      const occupied = {};
      for (const key of keys) {
        const nodeQr = key.split(':')[1]; // Extract QR from key
        const shuttleId = await redisClient.get(key);
        occupied[nodeQr] = shuttleId;
      }

      return occupied;
    } catch (error) {
      logger.error('[NodeOccupation] Error getting all occupied nodes:', error);
      return {};
    }
  }

  /**
   * Force unblock a node (admin function).
   *
   * @param {string} nodeQr - QR code of node to force unblock
   * @returns {Promise<boolean>} Success status
   */
  async forceUnblockNode(nodeQr) {
    try {
      const key = `node:${nodeQr}:occupied_by`;
      await redisClient.del(key);
      const nodeName = await cellService.getDisplayNameWithoutFloor(nodeQr);
      logger.warn(`[NodeOccupation] Force unblocked node ${nodeName}`);
      return true;
    } catch (error) {
      const nodeName = await cellService.getDisplayNameWithoutFloor(nodeQr);
      logger.error(`[NodeOccupation] Error force unblocking node ${nodeName}:`, error);
      return false;
    }
  }
}

module.exports = new NodeOccupationService();
