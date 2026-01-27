const redisClient = require('../../../redis/init.redis');
const { logger } = require('../../../logger/logger');

const ACTIVE_PATH_PREFIX = 'shuttle:active_path';
const PATH_METADATA_PREFIX = 'shuttle:path_metadata';
const DEFAULT_PATH_TTL = 600; // 10 minutes
const CLEANUP_INTERVAL = 30000; // 30 seconds

class PathCacheService {
  constructor() {
    this.cleanupTimer = null;
    this.isInitialized = false;
  }

  /**
   * Initialize the PathCacheService with automatic cleanup.
   */
  async initialize() {
    if (this.isInitialized) return;

    this.startAutoCleanup();
    this.isInitialized = true;
  }

  /**
   * Start automatic cleanup of stale paths.
   */
  startAutoCleanup() {
    this.cleanupTimer = setInterval(async () => {
      await this.cleanupStalePaths();
    }, CLEANUP_INTERVAL);
  }

  /**
   * Stop automatic cleanup.
   */
  stopAutoCleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Cleanup stale paths that have exceeded their TTL or belong to inactive shuttles.
   */
  async cleanupStalePaths() {
    try {
      const keys = await redisClient.keys(`${ACTIVE_PATH_PREFIX}:*`);
      let cleanedCount = 0;

      for (const key of keys) {
        const shuttleId = key.split(':')[2];
        const metadata = await this.getPathMetadata(shuttleId);

        if (!metadata) {
          // No metadata means path is stale or corrupted
          await redisClient.del(key);
          cleanedCount++;
          continue;
        }

        // Check if path has exceeded TTL
        const age = Date.now() - metadata.timestamp;
        const ttl = metadata.ttl || DEFAULT_PATH_TTL * 1000;

        if (age > ttl) {
          await this.deletePath(shuttleId);
          cleanedCount++;
        }
      }
    } catch (error) {
      logger.error('[PathCacheService] Error during cleanup:', error);
    }
  }

  /**
   * Stores a shuttle's active path in Redis with metadata.
   * @param {string} shuttleId - The ID of the shuttle.
   * @param {object} pathObject - The path object (e.g., from findShortestPath result).
   * @param {object} options - Optional metadata (isCarrying, priority, ttl)
   * @returns {Promise<boolean>} True if successful.
   */
  async savePath(shuttleId, pathObject, options = {}) {
    try {
      const key = `${ACTIVE_PATH_PREFIX}:${shuttleId}`;
      const ttl = options.ttl || DEFAULT_PATH_TTL;

      // Save path
      await redisClient.set(key, JSON.stringify(pathObject), { EX: ttl });

      // Save metadata
      const metadata = {
        shuttleId,
        timestamp: Date.now(),
        ttl: ttl * 1000,
        isCarrying: options.isCarrying || false,
        priority: options.priority || 0,
        pathLength: pathObject.totalStep || 0,
      };
      await this.savePathMetadata(shuttleId, metadata);

      return true;
    } catch (error) {
      logger.error(`[PathCacheService] Error saving path for ${shuttleId}:`, error);
      return false;
    }
  }
  async savePathMetadata(shuttleId, metadata) {
    try {
      const key = `${PATH_METADATA_PREFIX}:${shuttleId}`;
      await redisClient.set(key, JSON.stringify(metadata), { EX: metadata.ttl / 1000 + 60 }); // Extra 60s buffer
      return true;
    } catch (error) {
      logger.error(`[PathCacheService] Error saving metadata for ${shuttleId}:`, error);
      return false;
    }
  }

  async getPathMetadata(shuttleId) {
    try {
      const key = `${PATH_METADATA_PREFIX}:${shuttleId}`;
      const metadataJson = await redisClient.get(key);
      return metadataJson ? JSON.parse(metadataJson) : null;
    } catch (error) {
      logger.error(`[PathCacheService] Error getting metadata for ${shuttleId}:`, error);
      return null;
    }
  }

  async getPath(shuttleId) {
    try {
      const key = `${ACTIVE_PATH_PREFIX}:${shuttleId}`;
      const pathJson = await redisClient.get(key);
      return pathJson ? JSON.parse(pathJson) : null;
    } catch (error) {
      logger.error(`[PathCacheService] Error getting path for ${shuttleId}:`, error);
      return null;
    }
  }

  async deletePath(shuttleId) {
    try {
      const pathKey = `${ACTIVE_PATH_PREFIX}:${shuttleId}`;
      const metadataKey = `${PATH_METADATA_PREFIX}:${shuttleId}`;
      await redisClient.del(pathKey);
      await redisClient.del(metadataKey);
      return true;
    } catch (error) {
      logger.error(`[PathCacheService] Error deleting path for ${shuttleId}:`, error);
      return false;
    }
  }

  /**
   * Retrieves all active paths from Redis with metadata.
   * @returns {Promise<Array<{shuttleId: string, path: Array<{qrCode: string, direction: number}>, metadata: object}>>} Array of active paths.
   */
  async getAllActivePaths() {
    try {
      const keys = await redisClient.keys(`${ACTIVE_PATH_PREFIX}:*`);
      const paths = await Promise.all(
        keys.map(async (key) => {
          const shuttleId = key.split(':')[2];
          const pathJson = await redisClient.get(key);

          if (!pathJson) return null;

          const pathObject = JSON.parse(pathJson);
          const metadata = await this.getPathMetadata(shuttleId);

          // Convert path object format { totalStep, step1, step2, ... } to array format
          // Each step is "QR_CODE>direction:action"
          const pathArray = [];
          for (let i = 1; i <= pathObject.totalStep; i++) {
            const stepString = pathObject[`step${i}`];
            if (stepString) {
              // Parse "QR_CODE>direction:action" format
              const match = stepString.match(/^([^>]+)>(\d+):(\d+)$/);
              if (match) {
                pathArray.push({
                  qrCode: match[1],
                  direction: parseInt(match[2]),
                  action: parseInt(match[3]),
                });
              }
            }
          }

          return {
            shuttleId,
            path: pathArray,
            metadata: metadata || { isCarrying: false, priority: 0 },
          };
        })
      );
      return paths.filter((p) => p !== null);
    } catch (error) {
      logger.error(`[PathCacheService] Error getting all active paths:`, error);
      return [];
    }
  }

  /**
   * Detect traffic flow corridors - paths where multiple shuttles are moving in the same direction.
   * This helps identify high-traffic areas that should be avoided or treated with caution.
   *
   * @returns {Promise<Map<string, object>>} Map of node QR codes to traffic flow info
   */
  async detectTrafficFlowCorridors() {
    try {
      const allPaths = await this.getAllActivePaths();
      const nodeTrafficMap = new Map();

      // Analyze each path and aggregate traffic data per node
      for (const { shuttleId, path, metadata } of allPaths) {
        for (let i = 0; i < path.length; i++) {
          const step = path[i];
          const qrCode = step.qrCode;

          if (!nodeTrafficMap.has(qrCode)) {
            nodeTrafficMap.set(qrCode, {
              qrCode,
              shuttleCount: 0,
              directions: {},
              carryingCount: 0,
              avgPriority: 0,
              totalPriority: 0,
            });
          }

          const nodeData = nodeTrafficMap.get(qrCode);
          nodeData.shuttleCount++;

          // Track direction frequency
          const dir = step.direction;
          nodeData.directions[dir] = (nodeData.directions[dir] || 0) + 1;

          // Track carrying shuttles
          if (metadata.isCarrying) {
            nodeData.carryingCount++;
          }

          // Track priority
          nodeData.totalPriority += metadata.priority || 0;
          nodeData.avgPriority = nodeData.totalPriority / nodeData.shuttleCount;
        }
      }

      // Identify corridors (nodes with 2+ shuttles moving in same dominant direction)
      const corridors = new Map();
      for (const [qrCode, data] of nodeTrafficMap.entries()) {
        if (data.shuttleCount >= 2) {
          // Find dominant direction
          const dirEntries = Object.entries(data.directions);
          const dominantDir = dirEntries.reduce((max, curr) => (curr[1] > max[1] ? curr : max));

          // If dominant direction has 70%+ of traffic, it's a corridor
          const dominanceRatio = dominantDir[1] / data.shuttleCount;
          if (dominanceRatio >= 0.7) {
            corridors.set(qrCode, {
              ...data,
              dominantDirection: parseInt(dominantDir[0]),
              dominanceRatio,
              isHighTraffic: data.shuttleCount >= 3,
            });
          }
        }
      }

      return corridors;
    } catch (error) {
      logger.error('[PathCacheService] Error detecting traffic flow corridors:', error);
      return new Map();
    }
  }

  /**
   * Check if a node is in a high-traffic corridor.
   * @param {string} qrCode - Node QR code
   * @param {number} intendedDirection - Direction we intend to move (1-4)
   * @returns {Promise<object|null>} Corridor info if in corridor, null otherwise
   */
  async checkCorridorStatus(qrCode, intendedDirection) {
    try {
      const corridors = await this.detectTrafficFlowCorridors();
      const corridor = corridors.get(qrCode);

      if (!corridor) return null;

      // Check if our intended direction aligns with corridor
      const isWithTraffic = corridor.dominantDirection === intendedDirection;
      const oppositeDir = this.getOppositeDirection(intendedDirection);
      const isAgainstTraffic = corridor.dominantDirection === oppositeDir;

      return {
        ...corridor,
        isWithTraffic,
        isAgainstTraffic,
        recommendedPenalty: isAgainstTraffic ? 200 : isWithTraffic ? 20 : 50,
      };
    } catch (error) {
      logger.error('[PathCacheService] Error checking corridor status:', error);
      return null;
    }
  }

  /**
   * Get opposite direction helper.
   * @param {number} direction - Direction (1=up, 2=right, 3=down, 4=left)
   * @returns {number} Opposite direction
   */
  getOppositeDirection(direction) {
    const opposites = { 1: 3, 2: 4, 3: 1, 4: 2 };
    return opposites[direction] || direction;
  }
}

module.exports = new PathCacheService();
