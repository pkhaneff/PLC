// modules/SHUTTLE/shuttleStateCache.js

const { logger } = require('../../logger/logger');

/**
 * @type {Map<string, object>}
 * @description In-memory cache for storing the real-time state of all shuttles.
 * Key: shuttleCode (string), Value: shuttle state payload (object)
 */
const shuttleStates = new Map();

/**
 * Updates the state of a specific shuttle in the cache.
 * @param {string} shuttleCode - The unique code of the shuttle (e.g., '002').
 * @param {object} state - The shuttle state object received from MQTT.
 */  
function updateShuttleState(shuttleCode, state) {
    logger.debug({
        message: `Updating state for shuttle ${shuttleCode} in cache `,
        data: state
    });
    shuttleStates.set(shuttleCode, state);
}

/**
 * Retrieves the state of a specific shuttle from the cache.
 * @param {string} shuttleCode - The unique code of the shuttle.
 * @returns {object | undefined} The shuttle state object, or undefined if not found.
 */
function getShuttleState(shuttleCode) {
    return shuttleStates.get(shuttleCode);
}

/**
 * Retrieves the states of all shuttles currently in the cache.
 * @returns {Array<object>} An array of all shuttle state objects.
 */
function getAllShuttleStates() {
    return Array.from(shuttleStates.values());
}

module.exports = {
    shuttleStates,
    updateShuttleState,
    getShuttleState,
    getAllShuttleStates
};
