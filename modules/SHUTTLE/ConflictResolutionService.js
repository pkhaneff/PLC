const { logger } = require('../../logger/logger');
const PriorityCalculationService = require('./PriorityCalculationService');
const ParkingNodeService = require('./ParkingNodeService');
const BacktrackService = require('./BacktrackService');
const RerouteService = require('./RerouteService');
const { getShuttleState } = require('./shuttleStateCache');
const redisClient = require('../../redis/init.redis');
const PathCacheService = require('./PathCacheService'); // Import PathCacheService

/**
 * Main orchestrator for conflict resolution.
 * 
 * Coordinates all conflict resolution strategies:
 * 1. Priority comparison
 * 2. Parking node strategy (preferred)
 * 3. Backtrack strategy (fallback)
 * 4. Wait with backup reroute (last resort)
 * 
 * Decision Flow:
 * - Detect conflict
 * - Compare priorities
 * - If higher priority → request other shuttle to yield
 * - If lower priority → yield (find parking or backtrack)
 * - Monitor resolution with timeout
 * - Apply backup if timeout
 */
class ConflictResolutionService {

    /**
     * Handle conflict event from shuttle-waiting.
     * 
     * @param {string} shuttleId - ID of shuttle experiencing conflict
     * @param {object} event - Event payload from MQTT
     * @returns {Promise<object>} Resolution result
     */
    async handleConflict(shuttleId, event) {
        try {
            logger.info(`[ConflictResolution] Handling conflict for shuttle ${shuttleId}`);

            // Extract conflict information
            const { waitingAt, targetNode, blockedBy } = event;

            const conflict = {
                shuttleId,
                currentNode: waitingAt,
                conflictNode: targetNode,
                blockedBy
            };

            // Get shuttle state and task info
            const shuttleState = getShuttleState(shuttleId);
            if (!shuttleState) {
                logger.error(`[ConflictResolution] Shuttle ${shuttleId} state not found`);
                return { success: false, reason: 'Shuttle state not found' };
            }

            // Get task info from Redis or state
            const taskInfo = await this.getTaskInfo(shuttleId);

            // Compare priorities if we know who is blocking
            if (blockedBy) {
                const blockerTaskInfo = await this.getTaskInfo(blockedBy);
                const comparison = await PriorityCalculationService.comparePriority(
                    shuttleId, taskInfo,
                    blockedBy, blockerTaskInfo
                );

                if (comparison.winner === shuttleId) {
                    // We have higher priority - DO NOT YIELD, continue moving
                    logger.info(`[ConflictResolution] Shuttle ${shuttleId} has higher priority, no yield needed. Requesting ${blockedBy} to yield.`);

                    // Request the blocker (lower priority shuttle) to yield
                    await this.requestYield(blockedBy, shuttleId, conflict);

                    return {
                        success: true,
                        action: 'NO_YIELD',
                        message: `Shuttle ${shuttleId} has higher priority, waiting for ${blockedBy} to clear`
                    };
                } else {
                    // We have lower priority - we must yield
                    logger.info(`[ConflictResolution] Shuttle ${shuttleId} has lower priority, yielding to ${blockedBy}`);
                    return await this.handleYield(shuttleId, conflict, shuttleState);
                }
            } else {
                // Don't know who is blocking - use conflict node to find potential blocker
                logger.info(`[ConflictResolution] Blocker unknown for shuttle ${shuttleId}, attempting to identify from conflict node`);
                const potentialBlocker = await this.findShuttleAtNode(conflict.conflictNode);

                if (potentialBlocker && potentialBlocker !== shuttleId) {
                    logger.info(`[ConflictResolution] Found shuttle ${potentialBlocker} at conflict node ${conflict.conflictNode}`);
                    const blockerTaskInfo = await this.getTaskInfo(potentialBlocker);
                    const comparison = await PriorityCalculationService.comparePriority(
                        shuttleId, taskInfo,
                        potentialBlocker, blockerTaskInfo
                    );

                    if (comparison.winner === shuttleId) {
                        // We have higher priority - DO NOT YIELD
                        logger.info(`[ConflictResolution] Shuttle ${shuttleId} has higher priority, no yield needed. Requesting ${potentialBlocker} to yield.`);

                        // Request the blocker to yield
                        await this.requestYield(potentialBlocker, shuttleId, conflict);

                        return {
                            success: true,
                            action: 'NO_YIELD',
                            message: `Shuttle ${shuttleId} has higher priority, waiting for ${potentialBlocker} to clear`
                        };
                    } else {
                        // We have lower priority - we must yield
                        logger.info(`[ConflictResolution] Shuttle ${shuttleId} has lower priority, yielding to ${potentialBlocker}`);
                        return await this.handleYield(shuttleId, conflict, shuttleState);
                    }
                } else {
                    // Still can't identify blocker - wait in place (don't yield immediately)
                    logger.warn(`[ConflictResolution] Cannot identify blocker for shuttle ${shuttleId}, waiting in place`);
                    return await this.waitAtNode(shuttleId, conflict.currentNode, conflict, await this.getFloorId(conflict.currentNode));
                }
            }

        } catch (error) {
            logger.error(`[ConflictResolution] Error handling conflict:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Handle yield strategy for lower priority shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle that must yield
     * @param {object} conflict - Conflict information
     * @param {object} shuttleState - Shuttle state
     * @returns {Promise<object>} Yield result
     */
    async handleYield(shuttleId, conflict, shuttleState) {
        try {
            logger.info(`[ConflictResolution] Executing yield strategy for shuttle ${shuttleId}`);

            // Get floor ID
            const floorId = await this.getFloorId(shuttleState.qrCode);

            // Strategy 1: Try parking node
            const parkingNode = await ParkingNodeService.findAvailableParkingNode({
                nearNode: conflict.currentNode,
                conflictNode: conflict.conflictNode,
                shuttleId,
                floorId
            });

            if (parkingNode) {
                logger.info(`[ConflictResolution] Using parking strategy for ${shuttleId}`);
                return await this.useParkingStrategy(shuttleId, parkingNode, conflict, floorId);
            }

            // Strategy 2: Try backtrack
            logger.info(`[ConflictResolution] No parking available, trying backtrack strategy for ${shuttleId}`);
            return await this.useBacktrackStrategy(shuttleId, conflict, floorId);

        } catch (error) {
            logger.error(`[ConflictResolution] Error in yield strategy:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Use parking node strategy.
     *
     * @param {string} shuttleId - ID of shuttle
     * @param {string} parkingNode - QR code of parking node
     * @param {object} conflict - Conflict information
     * @param {number} floorId - Floor ID
     * @returns {Promise<object>} Result
     */
    async useParkingStrategy(shuttleId, parkingNode, conflict, floorId) {
        try {
            logger.info(`[ConflictResolution] Executing parking strategy for shuttle ${shuttleId} at ${parkingNode}`);

            // Validate path to parking
            const validation = await ParkingNodeService.validatePathToParking(
                conflict.currentNode,
                parkingNode,
                shuttleId,
                floorId
            );

            if (!validation.isValid) {
                logger.warn(`[ConflictResolution] Path to parking invalid: ${validation.reason}`);
                // Fallback to backtrack
                return await this.useBacktrackStrategy(shuttleId, conflict, floorId);
            }

            // Calculate path to parking
            const { findShortestPath } = require('./pathfinding');
            const pathToParking = await findShortestPath(conflict.currentNode, parkingNode, floorId);

            if (!pathToParking) {
                logger.error(`[ConflictResolution] Cannot find path to parking ${parkingNode}`);
                return await this.useBacktrackStrategy(shuttleId, conflict, floorId);
            }

            // Send MQTT command to move to parking
            const mqttService = require('../../services/mqttService');
            const commandTopic = `shuttle/command/${shuttleId}`;
            const commandPayload = {
                action: 'MOVE_TO_PARKING',
                path: pathToParking,
                destination: parkingNode,
                reason: 'Yielding to higher priority shuttle',
                onArrival: 'PARKING_COMPLETE'
            };

            mqttService.publishToTopic(commandTopic, commandPayload);
            logger.info(`[ConflictResolution] Sent MOVE_TO_PARKING command to shuttle ${shuttleId}`);

            // Update shuttle status
            await redisClient.set(`shuttle:${shuttleId}:status`, 'MOVING_TO_PARKING', { EX: 300 });
            await redisClient.set(`shuttle:${shuttleId}:parking_node`, parkingNode, { EX: 300 });

            // Start monitoring and backup calculation
            await this.waitAtNode(shuttleId, parkingNode, conflict, floorId);

            // Increment stats
            await redisClient.incr('stats:conflicts:parking_used');

            return {
                success: true,
                strategy: 'PARKING',
                parkingNode,
                message: `Shuttle ${shuttleId} moving to parking ${parkingNode}`
            };

        } catch (error) {
            logger.error(`[ConflictResolution] Error in parking strategy:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Use backtrack strategy.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {object} conflict - Conflict information
     * @param {number} floorId - Floor ID
     * @returns {Promise<object>} Result
     */
    async useBacktrackStrategy(shuttleId, conflict, floorId) {
        try {
            logger.info(`[ConflictResolution] Executing backtrack strategy for shuttle ${shuttleId}`);

            // Find safe backtrack node
            const backtrackResult = await BacktrackService.findSafeBacktrackNode(shuttleId, conflict, floorId);

            if (!backtrackResult) {
                logger.error(`[ConflictResolution] No safe backtrack node found for ${shuttleId}`);
                // Last resort: wait at current position
                return await this.waitAtNode(shuttleId, conflict.currentNode, conflict, floorId);
            }

            if (backtrackResult.action === 'BACKTRACK_TO_PARKING') {
                // Send backtrack command
                const backtracked = await BacktrackService.backtrackToNode(
                    shuttleId,
                    backtrackResult.backtrackNode,
                    backtrackResult.backtrackSteps,
                    floorId
                );

                if (!backtracked) {
                    logger.error(`[ConflictResolution] Backtrack failed for ${shuttleId}`);
                    return { success: false, strategy: 'BACKTRACK_FAILED' };
                }

                // Store next action - shuttle will move to parking after arriving at backtrack node
                await redisClient.set(`shuttle:${shuttleId}:next_action`, 'MOVE_TO_PARKING', { EX: 300 });
                await redisClient.set(`shuttle:${shuttleId}:parking_target`, backtrackResult.parkingNode, { EX: 300 });

                logger.info(`[ConflictResolution] Shuttle ${shuttleId} will move to parking ${backtrackResult.parkingNode} after backtrack`);

                // Increment stats
                await redisClient.incr('stats:conflicts:backtrack_used');

                return {
                    success: true,
                    strategy: 'BACKTRACK_THEN_PARKING',
                    backtrackNode: backtrackResult.backtrackNode,
                    backtrackSteps: backtrackResult.backtrackSteps,
                    parkingNode: backtrackResult.parkingNode,
                    message: `Shuttle ${shuttleId} backtracking ${backtrackResult.backtrackSteps} steps, then moving to parking`
                };
            } else {
                // Backtrack and wait at that position
                const backtracked = await BacktrackService.backtrackToNode(
                    shuttleId,
                    backtrackResult.backtrackNode,
                    backtrackResult.backtrackSteps,
                    floorId
                );

                if (!backtracked) {
                    logger.error(`[ConflictResolution] Backtrack failed for ${shuttleId}`);
                    return { success: false, strategy: 'BACKTRACK_FAILED' };
                }

                // Store waiting info
                await redisClient.set(`shuttle:${shuttleId}:next_action`, 'WAIT', { EX: 300 });
                await redisClient.set(`shuttle:${shuttleId}:status`, 'BACKTRACKING', { EX: 300 });

                // Increment stats
                await redisClient.incr('stats:conflicts:backtrack_used');

                return {
                    success: true,
                    strategy: 'BACKTRACK_AND_WAIT',
                    backtrackNode: backtrackResult.backtrackNode,
                    backtrackSteps: backtrackResult.backtrackSteps,
                    message: `Shuttle ${shuttleId} backtracked ${backtrackResult.backtrackSteps} steps and will wait`
                };
            }

        } catch (error) {
            logger.error(`[ConflictResolution] Error in backtrack strategy:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Wait at a node with timeout and backup calculation.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {string} waitNode - QR code of node to wait at
     * @param {object} conflict - Conflict information
     * @param {number} floorId - Floor ID
     * @returns {Promise<void>}
     */
    async waitAtNode(shuttleId, waitNode, conflict, floorId) {
        try {
            logger.info(`[ConflictResolution] Shuttle ${shuttleId} waiting at ${waitNode}`);

            // Set waiting state in Redis
            const waitingSince = Date.now();
            await redisClient.set(`shuttle:${shuttleId}:waiting_since`, waitingSince.toString(), { EX: 300 });
            await redisClient.set(`shuttle:${shuttleId}:status`, 'WAITING', { EX: 300 });

            // Get target node for backup calculation
            const taskInfo = await this.getTaskInfo(shuttleId);
            const targetNode = taskInfo?.endNodeQr || taskInfo?.pickupNodeQr;
            const shuttleState = getShuttleState(shuttleId); // Get current shuttle state for isCarrying

            if (targetNode) {
                // Get traffic data for background reroute calculation
                const trafficData = await PathCacheService.getAllActivePaths();

                // Start background backup calculation with dynamic options
                RerouteService.calculateBackupInBackground(
                    shuttleId,
                    conflict,
                    waitNode,
                    targetNode,
                    floorId,
                    {
                        isCarrying: shuttleState?.isCarrying || false,
                        waitingTime: 0, // Initial waiting time
                        emergency: false,
                        trafficData: trafficData
                    }
                ).catch(err => {
                    logger.error(`[ConflictResolution] Background backup calculation error:`, err);
                });
            }

            // Set initial timeout for the first re-evaluation of waiting status (e.g., 5 seconds)
            const initialRetryDelay = 5000;
            setTimeout(async () => {
                await this.handleWaitTimeout(shuttleId, conflict, floorId, 0); // Pass current wait count (0 for first attempt)
            }, initialRetryDelay);

        } catch (error) {
            logger.error(`[ConflictResolution] Error in wait at node:`, error);
        }
    }

    /**
     * Handle wait timeout - apply backup reroute.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {object} conflict - Conflict information
     * @param {number} floorId - Floor ID
     * @returns {Promise<void>}
     */
    async handleWaitTimeout(shuttleId, conflict, floorId, retryCount) {
        try {
            // Check if still waiting
            const status = await redisClient.get(`shuttle:${shuttleId}:status`);
            if (status !== 'WAITING') {
                logger.info(`[ConflictResolution] Shuttle ${shuttleId} no longer waiting, timeout ignored`);
                return;
            }

            logger.warn(`[ConflictResolution] Wait timeout for shuttle ${shuttleId}, attempt ${retryCount + 1}`);

            // Retrieve current waiting time
            const waitingSince = await redisClient.get(`shuttle:${shuttleId}:waiting_since`);
            const currentTime = Date.now();
            const waitingTime = waitingSince ? (currentTime - parseInt(waitingSince, 10)) : 0;

            const taskInfo = await this.getTaskInfo(shuttleId);
            const shuttleState = getShuttleState(shuttleId);

            // Get traffic data for reroute calculation
            const trafficData = await PathCacheService.getAllActivePaths();

            let rerouteOptions = {
                isCarrying: shuttleState?.isCarrying || false,
                waitingTime: waitingTime,
                trafficData: trafficData,
                emergency: false
            };

            const EMERGENCY_TIMEOUT = 45000; // 45 seconds to emergency reroute
            if (waitingTime >= EMERGENCY_TIMEOUT) {
                rerouteOptions.emergency = true;
                logger.warn(`[ConflictResolution] Shuttle ${shuttleId} waiting for ${waitingTime}ms. Activating emergency reroute!`);
            }

            // Get target node for backup calculation (current target from current path/task)
            const currentPath = await PathCacheService.getPath(shuttleId);
            const targetNode = currentPath?.path?.meta?.endNodeQr || taskInfo?.endNodeQr || taskInfo?.pickupNodeQr;
            const currentNode = shuttleState?.qrCode; // Current position of shuttle

            if (!targetNode || !currentNode) {
                logger.error(`[ConflictResolution] Cannot determine target or current node for reroute of ${shuttleId}.`);
                // TODO: Escalate
                await redisClient.del(`shuttle:${shuttleId}:waiting_since`); // Clear waiting state
                return;
            }

            // Recalculate backup path with updated options
            const rerouteResult = await RerouteService.calculateBackupReroute(
                shuttleId,
                conflict, // Original conflict info might be useful for avoidance
                currentNode,
                targetNode,
                floorId,
                rerouteOptions
            );

            if (rerouteResult && rerouteResult.path) {
                await RerouteService.applyBackupPath(shuttleId, rerouteResult.path, `Wait timeout - attempt ${retryCount + 1}`);
                logger.info(`[ConflictResolution] Reroute applied for ${shuttleId} after ${waitingTime}ms wait.`);
                // Clear waiting state after successful reroute
                await redisClient.del(`shuttle:${shuttleId}:waiting_since`);
                return;
            } else {
                logger.warn(`[ConflictResolution] No suitable reroute found for ${shuttleId} after ${waitingTime}ms wait (attempt ${retryCount + 1}).`);
                
                const MAX_RETRIES = 5; // Example: Try 5 times before escalating
                const RETRY_INTERVAL_MS = 10000; // Example: Retry every 10 seconds

                if (retryCount < MAX_RETRIES && waitingTime < EMERGENCY_TIMEOUT) {
                    const nextRetryDelay = RETRY_INTERVAL_MS; // Simplified for now
                    logger.info(`[ConflictResolution] Scheduling next reroute attempt for ${shuttleId} in ${nextRetryDelay}ms.`);
                    setTimeout(async () => {
                        await this.handleWaitTimeout(shuttleId, conflict, floorId, retryCount + 1);
                    }, nextRetryDelay);
                } else {
                    logger.error(`[ConflictResolution] Max reroute retries reached or emergency timeout for ${shuttleId}. Escalating.`);
                    // TODO: Escalate to human operator / external system
                    await redisClient.del(`shuttle:${shuttleId}:waiting_since`); // Clear waiting state
                }
            }

        } catch (error) {
            logger.error(`[ConflictResolution] Error handling wait timeout for ${shuttleId}:`, error);
        }
    }

    /**
     * Request another shuttle to yield.
     *
     * @param {string} targetShuttleId - ID of shuttle to yield
     * @param {string} requesterId - ID of requester
     * @param {object} conflict - Conflict information
     * @returns {Promise<object>} Result
     */
    async requestYield(targetShuttleId, requesterId, conflict) {
        try {
            logger.info(`[ConflictResolution] Requesting shuttle ${targetShuttleId} to yield to ${requesterId}`);

            // Get target shuttle state
            const { getShuttleState } = require('./shuttleStateCache');
            const targetState = getShuttleState(targetShuttleId);

            if (!targetState) {
                logger.error(`[ConflictResolution] Cannot request yield: shuttle ${targetShuttleId} state not found`);
                return { success: false, reason: 'Target shuttle state not found' };
            }

            // Get floor ID for target shuttle
            const floorId = await this.getFloorId(targetState.qrCode);

            // Directly trigger yield for target shuttle
            logger.info(`[ConflictResolution] Executing yield for shuttle ${targetShuttleId}`);
            const yieldResult = await this.handleYield(targetShuttleId, conflict, targetState);

            logger.info(`[ConflictResolution] Yield executed for ${targetShuttleId}, strategy: ${yieldResult.strategy || 'unknown'}`);

            return {
                success: true,
                action: 'YIELD_EXECUTED',
                targetShuttle: targetShuttleId,
                yieldStrategy: yieldResult.strategy,
                yieldResult: yieldResult
            };

        } catch (error) {
            logger.error(`[ConflictResolution] Error requesting yield:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get task info for a shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @returns {Promise<object>} Task info
     */
    async getTaskInfo(shuttleId) {
        try {
            const taskInfoJson = await redisClient.get(`shuttle:${shuttleId}:task_info`);
            if (taskInfoJson) {
                return JSON.parse(taskInfoJson);
            }

            // Default task info
            return {
                taskId: 0,
                isCarrying: false
            };
        } catch (error) {
            logger.error(`[ConflictResolution] Error getting task info:`, error);
            return { taskId: 0, isCarrying: false };
        }
    }

    /**
     * Get floor ID from a QR code.
     *
     * @param {string} qrCode - QR code
     * @returns {Promise<number>} Floor ID
     */
    async getFloorId(qrCode) {
        try {
            const cellService = require('./cellService');
            const cells = await cellService.getCellByQrCodeAnyFloor(qrCode);

            if (cells && cells.length > 0) {
                const floorId = cells[0].floor_id;
                logger.debug(`[ConflictResolution] Resolved QR ${qrCode} to floor ID ${floorId}`);
                return floorId;
            }

            // Fallback: if cell not found, log warning and return 1
            logger.warn(`[ConflictResolution] Could not find floor ID for QR ${qrCode}, defaulting to floor 1`);
            return 1;
        } catch (error) {
            logger.error(`[ConflictResolution] Error getting floor ID for QR ${qrCode}:`, error);
            return 1; // Fallback to floor 1
        }
    }

    /**
     * Find which shuttle is currently at a specific node.
     *
     * @param {string} nodeQr - QR code of node
     * @returns {Promise<string|null>} Shuttle ID or null
     */
    async findShuttleAtNode(nodeQr) {
        try {
            // First check Redis occupation tracking
            const key = `node:${nodeQr}:occupied_by`;
            const occupier = await redisClient.get(key);
            if (occupier) {
                return occupier;
            }

            // Fallback: search through shuttle states
            const allShuttles = require('./shuttleStateCache').getAllShuttleStates();
            const shuttleAtNode = allShuttles.find(s => s.qrCode === nodeQr);
            return shuttleAtNode ? shuttleAtNode.no : null;

        } catch (error) {
            logger.error(`[ConflictResolution] Error finding shuttle at node ${nodeQr}:`, error);
            return null;
        }
    }
}

module.exports = new ConflictResolutionService();
