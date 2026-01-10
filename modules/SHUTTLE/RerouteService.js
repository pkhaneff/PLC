const { logger } = require('../../logger/logger');
const { findShortestPath } = require('./pathfinding');
const { publishToTopic } = require('../../services/mqttService');
const redisClient = require('../../redis/init.redis');

/**
 * Service for calculating and applying reroute paths.
 * 
 * Reroute is used when:
 * - Shuttle is waiting and timeout occurs
 * - Need alternative path avoiding conflict nodes
 * - Backup path calculation during wait
 */
class RerouteService {

    /**
     * Calculate backup reroute path avoiding conflict nodes.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {object} conflict - Conflict information
     * @param {string} conflict.conflictNode - QR code of conflict node
     * @param {string} currentNode - Current QR code
     * @param {string} targetNode - Target node name
     * @param {number} floorId - Floor ID
     * @returns {Promise<object|null>} Reroute result or null
     */
    async calculateBackupReroute(shuttleId, conflict, currentNode, targetNode, floorId) {
        try {
            logger.info(`[Reroute] Calculating backup reroute for shuttle ${shuttleId} from ${currentNode} to ${targetNode}`);

            // Strategy 1: Try to find path avoiding conflict node
            const avoidNodes = [conflict.conflictNode];
            let backupPath = await findShortestPath(currentNode, targetNode, floorId, {
                avoid: avoidNodes
            });

            if (backupPath) {
                const isAcceptable = await this.validateRerouteCost(shuttleId, backupPath);
                if (isAcceptable.acceptable) {
                    logger.info(`[Reroute] Found acceptable backup path (cost: ${isAcceptable.costIncrease}%)`);
                    return {
                        type: 'REROUTE',
                        path: backupPath,
                        costIncrease: isAcceptable.costIncrease,
                        reason: 'Avoiding conflict node'
                    };
                } else {
                    logger.warn(`[Reroute] Backup path cost too high (${isAcceptable.costIncrease}% > 50%)`);
                }
            }

            // Strategy 2: Try path allowing conflicts (delayed reroute)
            backupPath = await findShortestPath(currentNode, targetNode, floorId);

            if (backupPath) {
                logger.info(`[Reroute] Found delayed reroute path (may encounter conflicts)`);
                return {
                    type: 'DELAYED_REROUTE',
                    path: backupPath,
                    reason: 'Path may encounter conflicts, will handle dynamically'
                };
            }

            // Strategy 3: No path found
            logger.error(`[Reroute] No backup path found from ${currentNode} to ${targetNode}`);
            return null;

        } catch (error) {
            logger.error(`[Reroute] Error calculating backup reroute:`, error);
            return null;
        }
    }

    /**
     * Validate if reroute cost is acceptable.
     * 
     * Cost is acceptable if new path is not more than 150% of original.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {object} newPath - New path object
     * @returns {Promise<object>} Validation result
     */
    async validateRerouteCost(shuttleId, newPath) {
        try {
            // Get original path from Redis
            const originalPathKey = `shuttle:${shuttleId}:path`;
            const originalPathJson = await redisClient.get(originalPathKey);

            let originalLength = 0;
            if (originalPathJson) {
                try {
                    const originalPath = JSON.parse(originalPathJson);
                    originalLength = originalPath.length;
                } catch (e) {
                    logger.error(`[Reroute] Error parsing original path:`, e);
                }
            }

            // If no original path, use new path length as baseline
            if (originalLength === 0) {
                originalLength = newPath.totalStep || 1;
            }

            const newLength = newPath.totalStep || 0;
            const maxAcceptable = Math.ceil(originalLength * 1.5); // 150% of original
            const costIncrease = ((newLength - originalLength) / originalLength * 100).toFixed(2);

            const acceptable = newLength <= maxAcceptable;

            logger.debug(`[Reroute] Cost validation: original=${originalLength}, new=${newLength}, max=${maxAcceptable}, increase=${costIncrease}%, acceptable=${acceptable}`);

            return {
                acceptable,
                originalLength,
                newLength,
                maxAcceptable,
                costIncrease: parseFloat(costIncrease)
            };

        } catch (error) {
            logger.error(`[Reroute] Error validating reroute cost:`, error);
            return {
                acceptable: false,
                error: error.message
            };
        }
    }

    /**
     * Apply backup path to shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {object} backupPath - Backup path object
     * @param {string} reason - Reason for reroute
     * @returns {Promise<boolean>} Success status
     */
    async applyBackupPath(shuttleId, backupPath, reason = 'Timeout waiting for conflict resolution') {
        try {
            logger.info(`[Reroute] Applying backup path to shuttle ${shuttleId}`);

            // Send reroute command via MQTT
            const commandTopic = `shuttle/command/${shuttleId}`;
            const commandPayload = {
                action: 'REROUTE',
                path: backupPath,
                reason,
                onArrival: 'REROUTE_COMPLETE'
            };

            publishToTopic(commandTopic, commandPayload);

            // Update shuttle state in Redis
            await redisClient.set(`shuttle:${shuttleId}:status`, 'REROUTING', { EX: 300 });
            await redisClient.set(`shuttle:${shuttleId}:backup_path`, JSON.stringify(backupPath), { EX: 300 });

            // Increment reroute counter
            await redisClient.incr('stats:reroutes:total');

            logger.info(`[Reroute] Reroute command sent to shuttle ${shuttleId}`);
            return true;

        } catch (error) {
            logger.error(`[Reroute] Error applying backup path:`, error);
            return false;
        }
    }

    /**
     * Clear backup path for a shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @returns {Promise<boolean>} Success status
     */
    async clearBackupPath(shuttleId) {
        try {
            await redisClient.del(`shuttle:${shuttleId}:backup_path`);
            logger.debug(`[Reroute] Cleared backup path for ${shuttleId}`);
            return true;
        } catch (error) {
            logger.error(`[Reroute] Error clearing backup path:`, error);
            return false;
        }
    }

    /**
     * Get backup path for a shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @returns {Promise<object|null>} Backup path or null
     */
    async getBackupPath(shuttleId) {
        try {
            const backupPathJson = await redisClient.get(`shuttle:${shuttleId}:backup_path`);
            if (!backupPathJson) {
                return null;
            }

            return JSON.parse(backupPathJson);
        } catch (error) {
            logger.error(`[Reroute] Error getting backup path:`, error);
            return null;
        }
    }

    /**
     * Calculate backup path in background (async).
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {object} conflict - Conflict information
     * @param {string} currentNode - Current QR code
     * @param {string} targetNode - Target node name
     * @param {number} floorId - Floor ID
     * @returns {Promise<void>}
     */
    async calculateBackupInBackground(shuttleId, conflict, currentNode, targetNode, floorId) {
        try {
            logger.info(`[Reroute] Starting background backup calculation for shuttle ${shuttleId}`);

            const backup = await this.calculateBackupReroute(shuttleId, conflict, currentNode, targetNode, floorId);

            if (backup) {
                // Store backup path in Redis
                await redisClient.set(`shuttle:${shuttleId}:backup_path`, JSON.stringify(backup.path), { EX: 300 });
                logger.info(`[Reroute] Background backup calculation complete for ${shuttleId}`);
            } else {
                logger.warn(`[Reroute] Background backup calculation failed for ${shuttleId}`);
            }

        } catch (error) {
            logger.error(`[Reroute] Error in background backup calculation:`, error);
        }
    }
}

module.exports = new RerouteService();
