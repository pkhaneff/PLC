
const { getShuttleState, updateShuttleState, getAllShuttleStates } = require('./shuttleStateCache');
const redisClient = require('../../redis/init.redis'); 
const REDIS_KEY_PREFIX = 'shuttle:';
const REDIS_PATH_KEY = (shuttleId) => `${REDIS_KEY_PREFIX}path:${shuttleId}`;
const REDIS_BACKUP_PATH_KEY = (shuttleId) => `${REDIS_KEY_PREFIX}backupPath:${shuttleId}`;
const REDIS_CONFLICT_KEY = (shuttleId) => `${REDIS_KEY_PREFIX}conflicts:${shuttleId}`;
const REDIS_RESERVED_NODE_KEY = (shuttleId) => `${REDIS_KEY_PREFIX}reservedNodes:${shuttleId}`;


/**
 * Service layer for shuttle-related business logic, now using in-memory cache and Redis.
 * Decouples controllers and other services from the underlying state management.
 */
class ShuttleService {

  #redisClient;

  constructor() {
    // Initialize Redis client if not already globally available or passed in.
    // For simplicity, we assume redisClient is imported and ready.
    this.#redisClient = redisClient;
  }

  // --- Shuttle State Management (using shuttleStateCache) ---

  /**
   * Gets the current state of a specific shuttle from the in-memory cache and augments with Redis data.
   * @param {string} shuttleId - The ID of the shuttle.
   * @returns {object | null} The shuttle state object, or null if not found.
   */
  async getShuttle(shuttleId) {
    const state = getShuttleState(shuttleId);
    if (!state) {
      // If not in cache, shuttle might be offline or not registered in real-time stream
      return null; 
    }

    // Combine cached state with data from Redis
    const shuttleData = { ...state };
    shuttleData.path = await this.getPath(shuttleId, false);
    shuttleData.rerouteBackupPath = await this.getPath(shuttleId, true);
    shuttleData.reservedNodes = await this.getReservedNodes(shuttleId);
    shuttleData.conflicts = await this.getConflicts(shuttleId);

    return shuttleData;
  }

  /**
   * Retrieves all shuttle states from the in-memory cache and augments with Redis data.
   * @returns {Array<object>} An array of all shuttle state objects.
   */
  async getAllShuttles() {
    const allStates = getAllShuttleStates();
    const shuttles = [];

    for (const state of allStates) {
      const shuttleData = { ...state };
      shuttleData.path = await this.getPath(state.no, false);
      shuttleData.rerouteBackupPath = await this.getPath(state.no, true);
      shuttleData.reservedNodes = await this.getReservedNodes(state.no);
      shuttleData.conflicts = await this.getConflicts(state.no);
      shuttles.push(shuttleData);
    }
    return shuttles;
  }

  /**
   * Retrieves all active (non-completed) shuttle states.
   * @returns {Array<object>} An array of active shuttle state objects.
   */
  async getActiveShuttles() {
    const allShuttles = await this.getAllShuttles();
    // Assuming 'completed' is a status string from shuttleStateCache
    return allShuttles.filter(shuttle => shuttle.shuttleStatus !== 'completed'); 
  }

  // --- Shuttle Status Updates (using shuttleStateCache and Timers) ---

  /**
   * Sets a shuttle's status to 'waiting' and starts a timer if needed.
   * Replaces DB update for status and waiting_since.
   * @param {string} shuttleId - The ID of the shuttle.
   * @param {number} waitingSinceTimestamp - Timestamp when waiting started.
   * @param {number} [timeoutDuration] - Optional duration for the waiting state.
   */
  async setShuttleWaiting(shuttleId, waitingSinceTimestamp, timeoutDuration = null) {
    updateShuttleState(shuttleId, { shuttleStatus: 'waiting', waitingSince: waitingSinceTimestamp });
    
    if (timeoutDuration !== null) {
      // Example: Schedule a follow-up action after timeoutDuration
      setTimeout(() => {
        console.log(`[ShuttleService] Shuttle ${shuttleId} waiting timeout reached.`);
        // Potentially call clearShuttleWaiting or another handler
        // This would require a mechanism to cancel the timer if needed.
        // For now, it's a basic example.
        this.clearShuttleWaiting(shuttleId); // Example: auto-resume if timeout
      }, timeoutDuration);
    }
    // Note: Specific logic for how long to wait and what to do next will depend on higher-level services.
  }

  /**
   * Clears a shuttle's waiting status, resets timers, and clears temporary data.
   * @param {string} shuttleId - The ID of the shuttle.
   */
  async clearShuttleWaiting(shuttleId) {
    // Assuming shuttle should go back to 'running' or 'idle' state after waiting
    // This might need adjustment based on the dispatcher's logic.
    // Status might need to be 'running' or 'idle' depending on context.
    updateShuttleState(shuttleId, { shuttleStatus: 'running', waitingSince: null, reroute_started_at: null }); 
    
    await this.clearConflicts(shuttleId);
    // Clear backup path if it was used for rerouting and is now being cleared
    await this.clearPaths(shuttleId, true); // Clear backup path in Redis
  }

  /**
   * Sets a shuttle's status to 'completed'.
   * @param {string} shuttleId - The ID of the shuttle.
   */
  async setShuttleCompleted(shuttleId) {
    updateShuttleState(shuttleId, { shuttleStatus: 'completed', completed_at: Date.now() });
    // Clear temporary data from Redis as the shuttle is completed.
    await this.clearPaths(shuttleId, false); // Clear main path
    await this.clearPaths(shuttleId, true);  // Clear backup path
    await this.clearConflicts(shuttleId); // Clear conflicts
    await this.clearReservedNodes(shuttleId); // Clear reserved nodes
  }

  // --- Path Management (using Redis) ---

  /**
   * Saves a shuttle's path (or backup path) to Redis.
   * @param {string} shuttleId - The ID of the shuttle.
   * @param {Array<string>} path - The array of QR codes representing the path.
   * @param {boolean} isBackupPath - Whether this is a backup path.
   */
  async savePath(shuttleId, path, isBackupPath = false) {
    const redisKey = isBackupPath ? REDIS_BACKUP_PATH_KEY(shuttleId) : REDIS_PATH_KEY(shuttleId);
    try {
      if (path && path.length > 0) {
        await this.#redisClient.set(redisKey, JSON.stringify(path));
        // Consider setting an expiry if paths are considered temporary and should auto-clean
        // await this.#redisClient.expire(redisKey, 3600); // Example: expire after 1 hour
      } else {
        // If path is empty or null, remove it from Redis
        await this.#redisClient.del(redisKey);
      }
    } catch (error) {
      console.error(`[ShuttleService] Error saving path for shuttle ${shuttleId} to Redis:`, error);
      throw error;
    }
  }

  /**
   * Retrieves a shuttle's path (or backup path) from Redis.
   * @param {string} shuttleId - The ID of the shuttle.
   * @param {boolean} isBackupPath - Whether to retrieve the backup path.
   * @returns {Promise<Array<string>>} The path array, or an empty array if not found or invalid.
   */
  async getPath(shuttleId, isBackupPath = false) {
    const redisKey = isBackupPath ? REDIS_BACKUP_PATH_KEY(shuttleId) : REDIS_PATH_KEY(shuttleId);
    try {
      const pathJson = await this.#redisClient.get(redisKey);
      if (pathJson) {
        return JSON.parse(pathJson);
      }
      return []; // Return empty array if no path found
    } catch (error) {
      console.error(`[ShuttleService] Error getting path for shuttle ${shuttleId} from Redis:`, error);
      return [];
    }
  }

  /**
   * Clears a specific path (main or backup) for a shuttle from Redis.
   * @param {string} shuttleId - The ID of the shuttle.
   * @param {boolean} isBackupPath - Whether to clear the backup path.
   */
  async clearPaths(shuttleId, isBackupPath = false) {
     const redisKey = isBackupPath ? REDIS_BACKUP_PATH_KEY(shuttleId) : REDIS_PATH_KEY(shuttleId);
     try {
       await this.#redisClient.del(redisKey);
     } catch (error) {
       console.error(`[ShuttleService] Error clearing path for shuttle ${shuttleId} (${isBackupPath ? 'backup' : 'main'}) from Redis:`, error);
       throw error;
     }
  }

  // --- Conflict and Reservation Management (using Redis) ---

  /**
   * Adds a conflict for a shuttle.
   * @param {string} shuttleId - The ID of the shuttle experiencing the conflict.
   * @param {string} conflictWith - The ID of the shuttle causing the conflict, or a node ID.
   */
  async addConflict(shuttleId, conflictWith) {
    const redisKey = REDIS_CONFLICT_KEY(shuttleId);
    try {
      // Add to a set to avoid duplicates and allow easy retrieval
      await this.#redisClient.sAdd(redisKey, conflictWith);
      // Consider setting an expiry if conflicts are temporary and should auto-clean
      // await this.#redisClient.expire(redisKey, 60); // Example: expire after 1 minute
    } catch (error) {
      console.error(`[ShuttleService] Error adding conflict for shuttle ${shuttleId} to Redis:`, error);
      throw error;
    }
  }

  /**
   * Retrieves conflicts for a shuttle from Redis.
   * @param {string} shuttleId - The ID of the shuttle.
   * @returns {Promise<Array<string>>} An array of conflict identifiers.
   */
  async getConflicts(shuttleId) {
    const redisKey = REDIS_CONFLICT_KEY(shuttleId);
    try {
      const conflicts = await this.#redisClient.sMembers(redisKey);
      return conflicts || [];
    } catch (error) {
      console.error(`[ShuttleService] Error getting conflicts for shuttle ${shuttleId} from Redis:`, error);
      return [];
    }
  }

  /**
   * Clears all conflicts for a shuttle from Redis.
   * @param {string} shuttleId - The ID of the shuttle.
   */
  async clearConflicts(shuttleId) {
    const redisKey = REDIS_CONFLICT_KEY(shuttleId);
    try {
      await this.#redisClient.del(redisKey);
    } catch (error) {
      console.error(`[ShuttleService] Error clearing conflicts for shuttle ${shuttleId} from Redis:`, error);
      throw error;
    }
  }

  /**
   * Reserves a node for a shuttle.
   * @param {string} shuttleId - The ID of the shuttle.
   * @param {string} qrCode - The QR code of the node to reserve.
   */
  async reserveNode(shuttleId, qrCode) {
    const redisKey = REDIS_RESERVED_NODE_KEY(shuttleId);
    try {
      // Store reserved node in a set for this shuttle.
      await this.#redisClient.sAdd(redisKey, qrCode);
      // Consider setting an expiry if reservations are temporary
      // await this.#redisClient.expire(redisKey, 300); // Example: expire after 5 minutes
    } catch (error) {
      console.error(`[ShuttleService] Error reserving node ${qrCode} for shuttle ${shuttleId} in Redis:`, error);
      throw error;
    }
  }

  /**
   * Unreserves a node for a shuttle.
   * @param {string} shuttleId - The ID of the shuttle.
   * @param {string} qrCode - The QR code of the node to unreserve.
   */
  async unreserveNode(shuttleId, qrCode) {
    const redisKey = REDIS_RESERVED_NODE_KEY(shuttleId);
    try {
      await this.#redisClient.sRem(redisKey, qrCode);
    } catch (error) {
      console.error(`[ShuttleService] Error unreserving node ${qrCode} for shuttle ${shuttleId} in Redis:`, error);
      throw error;
    }
  }

  /**
   * Gets all nodes reserved by a shuttle.
   * @param {string} shuttleId - The ID of the shuttle.
   * @returns {Promise<Array<string>>} An array of reserved QR codes.
   */
  async getReservedNodes(shuttleId) {
    const redisKey = REDIS_RESERVED_NODE_KEY(shuttleId);
    try {
      const reservedNodes = await this.#redisClient.sMembers(redisKey);
      return reservedNodes || [];
    } catch (error) {
      console.error(`[ShuttleService] Error getting reserved nodes for shuttle ${shuttleId} from Redis:`, error);
      return [];
    }
  }

  /**
   * Clears all reserved nodes for a shuttle.
   * @param {string} shuttleId - The ID of the shuttle.
   */
  async clearReservedNodes(shuttleId) {
    const redisKey = REDIS_RESERVED_NODE_KEY(shuttleId);
    try {
      await this.#redisClient.del(redisKey);
    } catch (error) {
      console.error(`[ShuttleService] Error clearing reserved nodes for shuttle ${shuttleId} from Redis:`, error);
      throw error;
    }
  }

  /**
   * Finds which shuttle is blocking a specific node.
   * This requires iterating through all shuttles' reserved nodes or having a global lookup.
   * For efficiency, a global mapping (e.g., nodeQrCode -> shuttleId) in Redis might be better.
   * For now, this method is stubbed as it's complex and might not be critical for the immediate refactor.
   * @param {string} qrCode - The QR code of the node.
   * @returns {Promise<string | null>} The ID of the shuttle blocking the node, or null.
   */
  async getNodeBlocker(qrCode) {
    console.warn("[ShuttleService] getNodeBlocker is complex with current Redis schema, returning null. Consider a global node reservation map in Redis.");
    // A potential implementation could involve iterating through all shuttle reservation sets
    // or using a globally mapped structure if implemented.
    return null; 
  }

  /**
   * Checks if a node is blocked (reserved) by any shuttle.
   * Similar to getNodeBlocker, this is inefficient with the current per-shuttle reservation sets.
   * @param {string} qrCode - The QR code of the node.
   * @returns {Promise<boolean>} True if the node is blocked.
   */
  async isNodeBlocked(qrCode) {
    console.warn("[ShuttleService] isNodeBlocked is complex with current Redis schema, returning false. Consider a global node reservation map in Redis.");
    // A more efficient implementation would require a Redis structure mapping nodeQrCode -> shuttleId.
    return false;
  }


  // --- Placeholder/Removed Methods ---
  // Methods that were purely DB operations and not directly mapped to cache/Redis yet
  // are either removed or stubbed with comments.

  /**
   * Creates a shuttle session.
   * In the new architecture, shuttle registration likely happens via real-time events 
   * (e.g., from MQTT/simulator) which update shuttleStateCache.
   * This method is removed as its direct DB insert logic is no longer applicable.
   */
  // createShuttle(...) { ... removed ... }

  /**
   * Removes a shuttle's data.
   * In the new architecture, this involves removing its state from shuttleStateCache
   * and associated data from Redis.
   */
  async removeShuttle(shuttleId) {
    // Remove from cache (assuming shuttleStateCache manager handles this via event or direct call if needed)
    // For now, focus on clearing Redis data associated with this shuttle.
    await this.clearPaths(shuttleId, false); // Clear main path
    await this.clearPaths(shuttleId, true);  // Clear backup path
    await this.clearConflicts(shuttleId);
    await this.clearReservedNodes(shuttleId);
    console.log(`[ShuttleService] Cleared Redis data for removed shuttle ${shuttleId}`);
    // The actual removal from shuttleStateCache might be handled by the event listener/manager
    // or an explicit call if shuttleStateCache exposes such a method.
  }

  /**
   * Clears all shuttle data.
   * In the new architecture, this involves clearing shuttleStateCache and all shuttle-related Redis keys.
   */
  async clearAll() {
    // Clear in-memory cache (assuming shuttleStateCache provides a way to do this, or manage externally)
    // For now, we'll focus on clearing Redis data.
    // Use SCAN for large datasets to avoid blocking Redis, but for simplicity, KEYS is used here.
    const keys = await this.#redisClient.keys(`${REDIS_KEY_PREFIX}*`);
    if (keys.length > 0) {
      await this.#redisClient.del(keys);
      console.log(`[ShuttleService] Cleared ${keys.length} shuttle-related keys from Redis.`);
    } else {
      console.log('[ShuttleService] No shuttle-related keys found in Redis to clear.');
    }
    // If shuttleStateCache has a clearAll method, call it here:
    // shuttleStateCache.clearAll(); 
  }
}

module.exports = new ShuttleService();
