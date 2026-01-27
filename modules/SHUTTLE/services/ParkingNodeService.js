const { logger } = require('../../../logger/logger');
const cellService = require('./cellService');
const { findShortestPath } = require('./pathfinding');
const { getAllShuttleStates } = require('./shuttleStateCache');
const ReservationService = require('../../COMMON/reservationService');
const redisClient = require('../../../redis/init.redis');

/**
 * Service for managing parking nodes in conflict resolution.
 *
 * Parking nodes are temporary waiting positions for lower-priority shuttles
 * during conflicts. They must meet specific criteria:
 * - Not blocked (is_block = 0)
 * - No box (is_has_box = 0)
 * - Not in any active shuttle's path
 * - Valid direction_type allowing entry/exit
 * - Accessible from current position
 */
class ParkingNodeService {
  /**
   * Find an available parking node near a conflict.
   *
   * @param {object} criteria - Search criteria
   * @param {string} criteria.nearNode - QR code of node near conflict
   * @param {string} criteria.conflictNode - QR code of conflict node
   * @param {string} criteria.shuttleId - ID of shuttle needing parking
   * @param {number} criteria.floorId - Floor ID to search on
   * @param {number} [criteria.maxDistance=3] - Maximum distance from nearNode
   * @returns {Promise<string|null>} QR code of parking node or null
   */
  async findAvailableParkingNode(criteria) {
    try {
      const { nearNode, conflictNode, shuttleId, floorId, maxDistance = 3 } = criteria;

      logger.info(
        `[ParkingNode] Finding parking for shuttle ${shuttleId} near ${nearNode}, conflict at ${conflictNode}`
      );

      // Get all cells on the floor
      const allCells = await cellService.getAllCellsByFloor(floorId);

      // Get all active shuttle paths to avoid
      const activePaths = await this.getAllActiveShuttlePaths();
      const activePathSet = new Set(activePaths);

      // Filter candidates
      const candidates = allCells.filter((cell) => {
        // Must not be blocked
        if (cell.is_block === 1) return false;

        // Must not have a box
        if (cell.is_has_box === 1) return false;

        // Must not be in any active path
        if (activePathSet.has(cell.qr_code) || activePathSet.has(cell.name)) {
          return false;
        }

        // Must not be the conflict node itself
        if (cell.qr_code === conflictNode || cell.name === conflictNode) {
          return false;
        }

        // Must have valid direction_type (not empty)
        if (!cell.direction_type || cell.direction_type.trim() === '') {
          return false;
        }

        return true;
      });

      if (candidates.length === 0) {
        logger.warn(`[ParkingNode] No parking candidates found on floor ${floorId}`);
        return null;
      }

      logger.debug(`[ParkingNode] Found ${candidates.length} parking candidates`);

      // Sort by distance from nearNode
      const nearCell = await cellService.getCellByQrCode(nearNode, floorId);
      if (!nearCell) {
        logger.error(`[ParkingNode] Near node ${nearNode} not found`);
        return null;
      }

      const candidatesWithDistance = candidates.map((cell) => ({
        cell,
        distance: this.calculateManhattanDistance(nearCell, cell),
      }));

      // Filter by max distance and sort
      const filtered = candidatesWithDistance
        .filter((c) => c.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance);

      if (filtered.length === 0) {
        logger.warn(`[ParkingNode] No parking nodes within distance ${maxDistance} from ${nearNode}`);
        return null;
      }

      // Try to reserve each candidate in order
      for (const { cell } of filtered) {
        const reserved = await this.reserveParkingNode(shuttleId, cell.qr_code);
        if (reserved) {
          logger.info(`[ParkingNode] Reserved parking node ${cell.qr_code} (${cell.name}) for shuttle ${shuttleId}`);
          return cell.qr_code;
        }
      }

      logger.warn(`[ParkingNode] All parking candidates are already reserved`);
      return null;
    } catch (error) {
      logger.error(`[ParkingNode] Error finding parking node:`, error);
      return null;
    }
  }

  /**
   * Reserve a parking node atomically using Redis lock.
   *
   * @param {string} shuttleId - ID of shuttle reserving the node
   * @param {string} nodeQr - QR code of parking node
   * @param {number} [timeout=60] - Lock timeout in seconds
   * @returns {Promise<boolean>} True if reserved successfully
   */
  async reserveParkingNode(shuttleId, nodeQr, timeout = 60) {
    try {
      const lockKey = `parking:${nodeQr}:lock`;
      const acquired = await ReservationService.acquireLock(lockKey, shuttleId, timeout);

      if (acquired) {
        // Also set a metadata key for tracking
        const metaKey = `parking:${nodeQr}:reserved_by`;
        await redisClient.set(metaKey, shuttleId, { EX: timeout });

        // Track in shuttle's state
        const shuttleKey = `shuttle:${shuttleId}:parking_node`;
        await redisClient.set(shuttleKey, nodeQr, { EX: timeout });

        logger.info(`[ParkingNode] Shuttle ${shuttleId} reserved parking ${nodeQr}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[ParkingNode] Error reserving parking node ${nodeQr}:`, error);
      return false;
    }
  }

  /**
   * Release a parking node reservation.
   *
   * @param {string} shuttleId - ID of shuttle releasing the node
   * @param {string} nodeQr - QR code of parking node
   * @returns {Promise<boolean>} True if released successfully
   */
  async releaseParkingNode(shuttleId, nodeQr) {
    try {
      const lockKey = `parking:${nodeQr}:lock`;
      const metaKey = `parking:${nodeQr}:reserved_by`;
      const shuttleKey = `shuttle:${shuttleId}:parking_node`;

      // Release lock
      await ReservationService.releaseLock(lockKey);

      // Clean up metadata
      await redisClient.del(metaKey);
      await redisClient.del(shuttleKey);

      logger.info(`[ParkingNode] Shuttle ${shuttleId} released parking ${nodeQr}`);
      return true;
    } catch (error) {
      logger.error(`[ParkingNode] Error releasing parking node ${nodeQr}:`, error);
      return false;
    }
  }

  /**
   * Validate that a shuttle can safely reach a parking node.
   *
   * @param {string} currentNode - Current QR code of shuttle
   * @param {string} parkingNode - QR code of parking node
   * @param {string} shuttleId - ID of shuttle
   * @param {number} floorId - Floor ID
   * @returns {Promise<object>} Validation result
   */
  async validatePathToParking(currentNode, parkingNode, shuttleId, floorId) {
    try {
      // Get current and parking cells
      const currentCell = await cellService.getCellByQrCode(currentNode, floorId);
      const parkingCell = await cellService.getCellByQrCode(parkingNode, floorId);

      if (!currentCell || !parkingCell) {
        return {
          isValid: false,
          reason: 'Current or parking node not found',
        };
      }

      // Find path to parking
      // Find path to parking
      const path = await findShortestPath(currentNode, parkingNode, floorId);

      if (!path) {
        return {
          isValid: false,
          reason: 'No path to parking node',
        };
      }

      // Check if path is blocked by higher priority shuttles
      const pathNodes = this.extractNodesFromPath(path);
      const blockedBy = await this.checkPathBlocked(pathNodes, shuttleId);

      if (blockedBy) {
        return {
          isValid: false,
          reason: `Path blocked by shuttle ${blockedBy}`,
          blockedBy,
        };
      }

      return {
        isValid: true,
        path,
        pathLength: pathNodes.length,
      };
    } catch (error) {
      logger.error(`[ParkingNode] Error validating path to parking:`, error);
      return {
        isValid: false,
        reason: 'Error during validation',
        error: error.message,
      };
    }
  }

  /**
   * Get all active shuttle paths.
   *
   * @returns {Promise<Array<string>>} Array of all QR codes in active paths
   */
  async getAllActiveShuttlePaths() {
    try {
      const allShuttles = await getAllShuttleStates();
      const allPaths = [];

      for (const shuttle of allShuttles) {
        // Get path from shuttle state cache
        if (shuttle.path && Array.isArray(shuttle.path)) {
          allPaths.push(...shuttle.path);
        }

        // Also check Redis for stored paths
        const redisPath = await redisClient.get(`shuttle:${shuttle.no || shuttle.id}:path`);
        if (redisPath) {
          try {
            const parsedPath = JSON.parse(redisPath);
            if (Array.isArray(parsedPath)) {
              allPaths.push(...parsedPath);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      return allPaths;
    } catch (error) {
      logger.error(`[ParkingNode] Error getting active paths:`, error);
      return [];
    }
  }

  /**
   * Calculate Manhattan distance between two cells.
   *
   * @param {object} cell1 - First cell
   * @param {object} cell2 - Second cell
   * @returns {number} Manhattan distance
   */
  calculateManhattanDistance(cell1, cell2) {
    return Math.abs(cell1.col - cell2.col) + Math.abs(cell1.row - cell2.row);
  }

  /**
   * Extract node QR codes from a path object.
   *
   * @param {object} path - Path object with step1, step2, etc.
   * @returns {Array<string>} Array of node QR codes
   */
  extractNodesFromPath(path) {
    if (!path || !path.totalStep) return [];

    const nodes = [];
    for (let i = 1; i <= path.totalStep; i++) {
      const step = path[`step${i}`];
      if (step) {
        const nodeQr = step.split('>')[0];
        nodes.push(nodeQr);
      }
    }
    return nodes;
  }

  /**
   * Check if a path is blocked by other shuttles.
   *
   * @param {Array<string>} pathNodes - Array of node QR codes in path
   * @param {string} shuttleId - ID of shuttle checking the path
   * @returns {Promise<string|null>} ID of blocking shuttle or null
   */
  async checkPathBlocked(pathNodes, shuttleId) {
    try {
      const allShuttles = await getAllShuttleStates();

      for (const shuttle of allShuttles) {
        if (shuttle.no === shuttleId) continue;

        // Check if shuttle is occupying any node in the path
        if (pathNodes.includes(shuttle.qrCode)) {
          // TODO: Check priority - only block if other shuttle has higher priority
          return shuttle.no;
        }
      }

      return null;
    } catch (error) {
      logger.error(`[ParkingNode] Error checking path blocked:`, error);
      return null;
    }
  }

  /**
   * Get parking node for a shuttle (if any).
   *
   * @param {string} shuttleId - ID of shuttle
   * @returns {Promise<string|null>} QR code of parking node or null
   */
  async getParkingNode(shuttleId) {
    try {
      const key = `shuttle:${shuttleId}:parking_node`;
      const parkingNode = await redisClient.get(key);
      return parkingNode;
    } catch (error) {
      logger.error(`[ParkingNode] Error getting parking node for ${shuttleId}:`, error);
      return null;
    }
  }

  /**
   * Check if a node is currently used as parking.
   *
   * @param {string} nodeQr - QR code of node
   * @returns {Promise<string|null>} ID of shuttle using it as parking or null
   */
  async isParkingNode(nodeQr) {
    try {
      const key = `parking:${nodeQr}:reserved_by`;
      const shuttleId = await redisClient.get(key);
      return shuttleId;
    } catch (error) {
      logger.error(`[ParkingNode] Error checking if ${nodeQr} is parking:`, error);
      return null;
    }
  }
}

module.exports = new ParkingNodeService();
