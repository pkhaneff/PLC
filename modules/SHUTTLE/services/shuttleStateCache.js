const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');

const SHUTTLE_STATE_PREFIX = 'shuttle:state:';
const SHUTTLE_STATE_TTL = 10; // 10 seconds TTL - auto cleanup if shuttle disconnects

/**
 * CRITICAL FIX: Store shuttle state in Redis instead of in-memory Map
 * This allows all processes (main app, scripts, workers) to access the same state.
 *
 * Structure:
 * Key: shuttle:state:{shuttleNo}
 * Type: Hash
 * TTL: 5 seconds (refreshed every 300ms by simulator)
 * Fields:
 *   - no: shuttle code
 *   - ip: shuttle IP address
 *   - currentStep: current step in mission (0-based index)
 *   - shuttleStatus: current status (8=IDLE, 9=WAITING, etc.)
 *   - commandComplete: 0=in progress, 1=completed
 *   - qrCode: current node QR code (also known as currentNode)
 *   - packageStatus: 0=no cargo, 1=carrying cargo, 2=misaligned
 *   - palletLiftingStatus: 0=down, 1=up (tấm nâng)
 *   - missionCompleted: total missions completed (counter)
 *   - lastUpdate: timestamp of last update
 */

/**
 * Updates the state of a specific shuttle in Redis.
 * @param {string} shuttleCode - The unique code of the shuttle (e.g., '001', '002').
 * @param {object} state - The shuttle state object received from MQTT.
 */
async function updateShuttleState(shuttleCode, state) {
  try {
    logger.debug({
      message: `Updating state for shuttle ${shuttleCode} in Redis`,
      data: state,
    });

    const redisKey = `${SHUTTLE_STATE_PREFIX}${shuttleCode}`;

    // Flatten the state object for Redis Hash storage
    const stateToStore = {
      no: state.no || shuttleCode,
      ip: state.ip || '',
      currentStep: String(state.currentStep || 0), // Current step in mission
      shuttleStatus: String(state.shuttleStatus || 8), // Convert to string for Redis
      commandComplete: String(state.commandComplete || 1),
      qrCode: state.qrCode || state.currentNode || state.current_node || '',
      current_node: state.currentNode || state.current_node || state.qrCode || '', // Keep for compatibility in Redis
      packageStatus: String(state.packageStatus || 0),
      isCarrying: state.packageStatus === 1 ? 'true' : 'false', // Derived field for convenience
      palletLiftingStatus: String(state.palletLiftingStatus || 0), // 0=hạ, 1=nâng
      missionCompleted: String(state.missionCompleted || 0), // Total missions completed counter
      taskId: state.taskId || (state.meta ? state.meta.taskId : ''),
      targetQr: state.targetQr || (state.meta ? state.meta.endNodeQr : ''),
      lastUpdate: String(Date.now()),
    };

    // Store in Redis Hash
    await redisClient.hSet(redisKey, stateToStore);

    // Set TTL to auto-cleanup stale data
    await redisClient.expire(redisKey, SHUTTLE_STATE_TTL);

    logger.debug(`[ShuttleStateCache] Updated shuttle ${shuttleCode} in Redis with TTL ${SHUTTLE_STATE_TTL}s`);
  } catch (error) {
    logger.error(`[ShuttleStateCache] Error updating shuttle ${shuttleCode} state:`, error);
  }
}

/**
 * Retrieves the state of a specific shuttle from Redis.
 * @param {string} shuttleCode - The unique code of the shuttle.
 * @returns {Promise<object | null>} The shuttle state object, or null if not found.
 */
async function getShuttleState(shuttleCode) {
  try {
    const redisKey = `${SHUTTLE_STATE_PREFIX}${shuttleCode}`;
    const state = await redisClient.hGetAll(redisKey);

    if (!state || Object.keys(state).length === 0) {
      return null;
    }

    // Convert string values back to appropriate types
    return {
      no: state.no,
      id: state.no, // Alias for compatibility
      ip: state.ip,
      currentStep: parseInt(state.currentStep, 10),
      shuttleStatus: parseInt(state.shuttleStatus, 10),
      commandComplete: parseInt(state.commandComplete, 10),
      qrCode: state.qrCode,
      currentNode: state.current_node || state.qrCode, // Map to camelCase
      current_node: state.current_node || state.qrCode, // Keep for compatibility
      packageStatus: parseInt(state.packageStatus, 10),
      isCarrying: state.isCarrying === 'true',
      palletLiftingStatus: parseInt(state.palletLiftingStatus, 10),
      missionCompleted: parseInt(state.missionCompleted, 10),
      taskId: state.taskId || '',
      targetQr: state.targetQr || '',
      lastUpdate: parseInt(state.lastUpdate, 10),
    };
  } catch (error) {
    logger.error(`[ShuttleStateCache] Error getting shuttle ${shuttleCode} state:`, error);
    return null;
  }
}

/**
 * Retrieves the states of all shuttles currently in Redis.
 * @returns {Promise<Array<object>>} An array of all shuttle state objects.
 */
async function getAllShuttleStates() {
  try {
    // Find all shuttle state keys
    const keys = await redisClient.keys(`${SHUTTLE_STATE_PREFIX}*`);

    if (!keys || keys.length === 0) {
      return [];
    }

    // Get all shuttle states in parallel
    const states = await Promise.all(
      keys.map(async (key) => {
        const shuttleCode = key.replace(SHUTTLE_STATE_PREFIX, '');
        return await getShuttleState(shuttleCode);
      }),
    );

    // Filter out null values
    return states.filter((state) => state !== null);
  } catch (error) {
    logger.error('[ShuttleStateCache] Error getting all shuttle states:', error);
    return [];
  }
}

module.exports = {
  updateShuttleState,
  getShuttleState,
  getAllShuttleStates,
};
