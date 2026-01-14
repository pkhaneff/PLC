const { logger } = require('../../logger/logger');
const { findShortestPath } = require('./pathfinding');
const { publishToTopic } = require('../../services/mqttService');
const redisClient = require('../../redis/init.redis');
const PathCacheService = require('./PathCacheService'); // Import PathCacheService

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
    async calculateBackupReroute(shuttleId, conflict, currentNode, targetNode, floorId, options = {}) {
        try {
            logger.info(`[Reroute] Calculating backup reroute for shuttle ${shuttleId} from ${currentNode} to ${targetNode} (isCarrying: ${options.isCarrying}, waiting: ${options.waitingTime}ms, emergency: ${options.emergency})`);

            const pathfindingOptions = {
                avoid: conflict ? [conflict.conflictNode] : [], // Avoid conflict node if provided
                isCarrying: options.isCarrying,
                trafficData: options.trafficData // Pass traffic data for proactive avoidance
            };

            // Strategy 1: Try to find path avoiding conflict node
            let backupPath = await findShortestPath(currentNode, targetNode, floorId, pathfindingOptions);

            if (backupPath) {
                const rerouteCostValidation = await this.validateRerouteCost(shuttleId, backupPath, options);
                if (rerouteCostValidation.acceptable) {
                    logger.info(`[Reroute] Found acceptable backup path (cost: ${rerouteCostValidation.costIncrease}%)`);
                    return {
                        type: 'REROUTE',
                        path: backupPath,
                        costIncrease: rerouteCostValidation.costIncrease,
                        reason: 'Avoiding conflict node'
                    };
                } else {
                    if (options.emergency) {
                        logger.warn(`[Reroute] Emergency reroute: backup path cost ${rerouteCostValidation.costIncrease}% (exceeds dynamic limit) but forced.`);
                         return {
                            type: 'EMERGENCY_REROUTE',
                            path: backupPath,
                            costIncrease: rerouteCostValidation.costIncrease,
                            reason: 'Emergency reroute due to long waiting time'
                        };
                    } else {
                        logger.warn(`[Reroute] Backup path cost too high (${rerouteCostValidation.costIncrease}% > ${rerouteCostValidation.maxAcceptablePercentage}%)`);
                    }
                }
            }

            // Strategy 2: If strategy 1 fails, try to find path without explicit conflict node avoidance
            // This relies on A* traffic avoidance to naturally find a detour.
            if (!backupPath) {
                logger.warn(`[Reroute] Strategy 1 (explicit conflict node avoidance) failed for shuttle ${shuttleId}. Trying dynamic avoidance.`);
                backupPath = await findShortestPath(currentNode, targetNode, floorId, {
                    isCarrying: options.isCarrying,
                    trafficData: options.trafficData
                });

                if (backupPath) {
                    const rerouteCostValidation = await this.validateRerouteCost(shuttleId, backupPath, options);
                     if (rerouteCostValidation.acceptable) {
                        logger.info(`[Reroute] Found acceptable backup path via dynamic avoidance (cost: ${rerouteCostValidation.costIncrease}%)`);
                        return {
                            type: 'REROUTE',
                            path: backupPath,
                            costIncrease: rerouteCostValidation.costIncrease,
                            reason: 'Dynamic conflict avoidance'
                        };
                    } else {
                        if (options.emergency) {
                            logger.warn(`[Reroute] Emergency reroute: backup path cost ${rerouteCostValidation.costIncrease}% (exceeds dynamic limit) but forced.`);
                             return {
                                type: 'EMERGENCY_REROUTE',
                                path: backupPath,
                                costIncrease: rerouteCostValidation.costIncrease,
                                reason: 'Emergency reroute due to long waiting time (dynamic avoidance)'
                            };
                        } else {
                            logger.warn(`[Reroute] Backup path via dynamic avoidance cost too high (${rerouteCostValidation.costIncrease}% > ${rerouteCostValidation.maxAcceptablePercentage}%)`);
                        }
                    }
                }
            }
            
            // Strategy 3: No path found
            logger.error(`[Reroute] No backup path found from ${currentNode} to ${targetNode} even with dynamic avoidance.`);
            return null;

        } catch (error) {
            logger.error(`[Reroute] Error calculating backup reroute:`, error);
            return null;
        }
    }

    /**
     * Validate if reroute cost is acceptable (Pillar 3: Multi-tier dynamic cost limits).
     *
     * Dynamic cost limits based on:
     * 1. Shuttle cargo status (empty vs carrying)
     * 2. Waiting time with escalating tolerance
     * 3. Retry count with increasing limits
     *
     * @param {string} shuttleId - ID of shuttle
     * @param {object} newPath - New path object
     * @param {object} options - Options (isCarrying, waitingTime, retryCount, emergency)
     * @returns {Promise<object>} Validation result
     */
    async validateRerouteCost(shuttleId, newPath, options = {}) {
        try {
            if (options.emergency) {
                logger.info(`[Reroute][Pillar3] Emergency flag set, accepting any path for ${shuttleId}`);
                return { acceptable: true, reason: 'Emergency timeout - accepting any path', tier: 'EMERGENCY' };
            }

            const originalPath = await PathCacheService.getPath(shuttleId);
            let originalLength = 0;
            if (originalPath && originalPath.totalStep) {
                originalLength = originalPath.totalStep;
            } else {
                logger.warn(`[Reroute] Original path not found in cache for ${shuttleId}. Using new path as baseline.`);
                originalLength = newPath.totalStep || 1;
            }

            const newLength = newPath.totalStep || 0;
            const costIncrease = originalLength > 0 ? ((newLength - originalLength) / originalLength * 100) : (newLength > 0 ? 100 : 0);

            // --- Pillar 3: Dynamic Multi-Tier Cost Limits ---

            // Tier 1: Base limit based on cargo status
            let maxAcceptablePercentage = 0;
            let tier = '';

            if (options.isCarrying) {
                maxAcceptablePercentage = 140; // Stricter for carrying shuttles (was 130)
                tier = 'TIER1_CARRYING';
            } else {
                maxAcceptablePercentage = 200; // Looser for empty shuttles
                tier = 'TIER1_EMPTY';
            }

            // Tier 2: Escalating limits based on retry count
            const retryCount = options.retryCount || 0;
            if (retryCount > 0) {
                const retryBonus = retryCount * 50; // +50% per retry
                maxAcceptablePercentage += retryBonus;
                tier = `TIER2_RETRY${retryCount}`;
                logger.debug(`[Reroute][Pillar3] Retry bonus: +${retryBonus}% (retry #${retryCount})`);
            }

            // Tier 3: Escalating limits based on waiting time
            if (options.waitingTime > 0) {
                const waitingSeconds = options.waitingTime / 1000;

                // Every 15 seconds of waiting adds +50% tolerance (was +25%)
                const timeBonus = Math.floor(waitingSeconds / 15) * 50;
                maxAcceptablePercentage += timeBonus;

                // After 45 seconds, automatically trigger emergency mode
                if (waitingSeconds >= 45 && !options.emergency) {
                    logger.warn(`[Reroute][Pillar3] Shuttle ${shuttleId} waited ${waitingSeconds}s - triggering TIER3_EMERGENCY`);
                    tier = 'TIER3_EMERGENCY';
                    maxAcceptablePercentage = 999; // Accept any path
                } else {
                    tier = tier + `_WAIT${Math.floor(waitingSeconds)}s`;
                }

                logger.debug(`[Reroute][Pillar3] Waiting time bonus: +${timeBonus}% (waiting ${waitingSeconds}s)`);
            }

            // Safety cap at 500% (unless emergency)
            if (tier !== 'TIER3_EMERGENCY' && tier !== 'EMERGENCY') {
                maxAcceptablePercentage = Math.min(maxAcceptablePercentage, 500);
            }

            const acceptable = costIncrease <= maxAcceptablePercentage;

            logger.info(`[Reroute][Pillar3] ${shuttleId} cost validation [${tier}]: original=${originalLength}, new=${newLength}, increase=${costIncrease.toFixed(2)}%, limit=${maxAcceptablePercentage}%, acceptable=${acceptable}`);

            return {
                acceptable,
                originalLength,
                newLength,
                costIncrease: parseFloat(costIncrease.toFixed(2)),
                maxAcceptablePercentage,
                tier
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
            // CRITICAL: Also update the main PathCacheService with the new path
            await PathCacheService.savePath(shuttleId, backupPath); // Update central path cache
            await redisClient.set(`shuttle:${shuttleId}:status`, 'REROUTING', { EX: 300 });
            // The `backup_path` key might not be needed anymore if PathCacheService is the source of truth
            // For now, keep it for existing dependencies or logging
            await redisClient.set(`shuttle:${shuttleId}:backup_path`, JSON.stringify(backupPath), { EX: 300 });
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
    async calculateBackupInBackground(shuttleId, conflict, currentNode, targetNode, floorId, options = {}) {
        try {
            logger.info(`[Reroute] Starting background backup calculation for shuttle ${shuttleId}`);

            const backup = await this.calculateBackupReroute(shuttleId, conflict, currentNode, targetNode, floorId, options);

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
