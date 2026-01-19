const { logger } = require('../../logger/logger');
const { findShortestPath, findShortestPathByQrCode } = require('./pathfinding');
const { getShuttleState } = require('./shuttleStateCache');
const { publishToTopic } = require('../../services/mqttService');
const redisClient = require('../../redis/init.redis');
const ParkingNodeService = require('./ParkingNodeService');
const cellService = require('./cellService');

/**
 * Service for handling shuttle backtracking in conflict resolution.
 * 
 * Backtracking is used when:
 * - No parking node is available
 * - Shuttle needs to yield to higher priority shuttle
 * - Need to find a safe waiting position
 * 
 * Strategy:
 * - Iteratively backtrack through path (1 step, 2 steps, etc.)
 * - At each backtrack node, check for parking availability
 * - If parking found → use parking strategy
 * - If safe waiting point → wait there
 * - Continue until solution found
 */
class BacktrackService {

    /**
     * Find a safe backtrack node for a shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @param {object} conflict - Conflict information
     * @param {string} conflict.conflictNode - QR code of conflict node
     * @param {number} floorId - Floor ID
     * @returns {Promise<object|null>} Backtrack result or null
     */
    async findSafeBacktrackNode(shuttleId, conflict, floorId) {
        try {
            logger.info(`[Backtrack] Finding safe backtrack node for shuttle ${shuttleId}`);

            // Get shuttle state
            const shuttleState = await getShuttleState(shuttleId);
            if (!shuttleState) {
                logger.error(`[Backtrack] Shuttle ${shuttleId} state not found`);
                return null;
            }

            // Get current path from Redis
            const pathKey = `shuttle:active_path:${shuttleId}`;
            const pathJson = await redisClient.get(pathKey);

            let path = [];
            if (pathJson) {
                try {
                    path = JSON.parse(pathJson);
                } catch (e) {
                    logger.error(`[Backtrack] Error parsing path for ${shuttleId}:`, e);
                }
            }

            // If no path in Redis, try to get from shuttle state
            if (path.length === 0 && shuttleState.path) {
                path = shuttleState.path;
            }

            if (path.length === 0) {
                logger.error(`[Backtrack] No path found for shuttle ${shuttleId}`);
                return null;
            }

            const currentNode = shuttleState.qrCode;
            const currentIndex = path.indexOf(currentNode);

            if (currentIndex === -1) {
                logger.error(`[Backtrack] Current node ${currentNode} not found in path`);
                return null;
            }

            // Try backtracking 1, 2, 3... steps
            const maxBacktrackSteps = Math.min(currentIndex, 5); // Max 5 steps back

            for (let steps = 1; steps <= maxBacktrackSteps; steps++) {
                const backtrackIndex = currentIndex - steps;
                const backtrackNode = path[backtrackIndex];

                logger.debug(`[Backtrack] Trying backtrack ${steps} steps to ${backtrackNode}`);

                // Check if node is occupied
                const isOccupied = await this.isNodeOccupied(backtrackNode);
                if (isOccupied) {
                    logger.debug(`[Backtrack] Node ${backtrackNode} is occupied, trying next`);
                    continue;
                }

                // Check if parking is available from this backtrack node
                const parkingNode = await ParkingNodeService.findAvailableParkingNode({
                    nearNode: backtrackNode,
                    conflictNode: conflict.conflictNode,
                    shuttleId,
                    floorId,
                    maxDistance: 2
                });

                if (parkingNode) {
                    logger.info(`[Backtrack] Found parking ${parkingNode} from backtrack node ${backtrackNode}`);
                    return {
                        action: 'BACKTRACK_TO_PARKING',
                        backtrackNode,
                        backtrackSteps: steps,
                        parkingNode,
                        reason: `Backtrack ${steps} steps and use parking`
                    };
                }

                // Check if this is a safe waiting point
                const isSafe = await this.isSafeToWait(backtrackNode, conflict);
                if (isSafe) {
                    logger.info(`[Backtrack] Found safe waiting point at ${backtrackNode}`);
                    return {
                        action: 'BACKTRACK_AND_WAIT',
                        backtrackNode,
                        backtrackSteps: steps,
                        reason: `Backtrack ${steps} steps and wait`
                    };
                }
            }

            logger.warn(`[Backtrack] No safe backtrack node found for shuttle ${shuttleId}`);
            return null;

        } catch (error) {
            logger.error(`[Backtrack] Error finding safe backtrack node:`, error);
            return null;
        }
    }

    async backtrackToNode(shuttleId, targetNode, steps, floorId) {
        try {
            logger.info(`[Backtrack] Executing backtrack for shuttle ${shuttleId} to ${targetNode} (${steps} steps)`);

            // Get shuttle state
            const shuttleState = await getShuttleState(shuttleId);
            if (!shuttleState) {
                logger.error(`[Backtrack] Shuttle ${shuttleId} state not found`);
                return false;
            }

            const currentNode = shuttleState.qrCode;

            // Validate both nodes exist before pathfinding
            const currentCell = await cellService.getCellByQrCode(currentNode, floorId);
            const targetCell = await cellService.getCellByQrCode(targetNode, floorId);

            if (!currentCell) {
                logger.error(`[Backtrack] Current node ${currentNode} not found on floor ${floorId}. Shuttle state may be out of sync.`);
                return false;
            }

            if (!targetCell) {
                logger.error(`[Backtrack] Target node ${targetNode} not found on floor ${floorId}. Cannot backtrack.`);
                return false;
            }

            const reversePath = await findShortestPathByQrCode(currentNode, targetNode, floorId);

            if (!reversePath) {
                logger.error(`[Backtrack] No path found from ${currentNode} to ${targetNode}`);
                return false;
            }

            // Send backtrack command via MQTT
            const commandTopic = `shuttle/command/${shuttleId}`;
            const commandPayload = {
                action: 'BACKTRACK',
                path: reversePath,
                reason: `Yielding to higher priority shuttle, backtracking ${steps} steps`,
                onArrival: 'BACKTRACK_COMPLETE'
            };

            publishToTopic(commandTopic, commandPayload);

            // Update shuttle state in Redis
            await redisClient.set(`shuttle:${shuttleId}:status`, 'BACKTRACKING', { EX: 300 });
            await redisClient.set(`shuttle:${shuttleId}:backtrack_target`, targetNode, { EX: 300 });
            await redisClient.set(`shuttle:${shuttleId}:backtrack_steps`, steps.toString(), { EX: 300 });

            logger.info(`[Backtrack] Backtrack command sent to shuttle ${shuttleId}`);
            return true;

        } catch (error) {
            logger.error(`[Backtrack] Error executing backtrack:`, error);
            return false;
        }
    }

    /**
     * Check if a node is safe for waiting.
     * 
     * A node is safe if:
     * - Not occupied by another shuttle
     * - Not in the path of higher priority shuttles
     * - Not the conflict node itself
     * 
     * @param {string} nodeQr - QR code of node
     * @param {object} conflict - Conflict information
     * @returns {Promise<boolean>} True if safe
     */
    async isSafeToWait(nodeQr, conflict) {
        try {
            // Don't wait at the conflict node
            if (nodeQr === conflict.conflictNode) {
                return false;
            }

            // Check if node is occupied
            const isOccupied = await this.isNodeOccupied(nodeQr);
            if (isOccupied) {
                return false;
            }

            // TODO: Check if node is in path of higher priority shuttles
            // For now, assume it's safe if not occupied

            return true;

        } catch (error) {
            logger.error(`[Backtrack] Error checking if safe to wait:`, error);
            return false;
        }
    }

    /**
     * Check if a node is currently occupied.
     * 
     * @param {string} nodeQr - QR code of node
     * @returns {Promise<boolean>} True if occupied
     */
    async isNodeOccupied(nodeQr) {
        try {
            const key = `node:${nodeQr}:occupied_by`;
            const occupier = await redisClient.get(key);
            return !!occupier;
        } catch (error) {
            logger.error(`[Backtrack] Error checking node occupation:`, error);
            return false;
        }
    }

    /**
     * Clear backtrack state for a shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @returns {Promise<boolean>} Success status
     */
    async clearBacktrackState(shuttleId) {
        try {
            await redisClient.del(`shuttle:${shuttleId}:backtrack_target`);
            await redisClient.del(`shuttle:${shuttleId}:backtrack_steps`);
            logger.debug(`[Backtrack] Cleared backtrack state for ${shuttleId}`);
            return true;
        } catch (error) {
            logger.error(`[Backtrack] Error clearing backtrack state:`, error);
            return false;
        }
    }

    /**
     * Resolve a node to QR code (handles Name inputs)
     * @param {string} node - QR or Name
     * @param {number} floorId - Floor ID
     * @returns {Promise<string|null>} QR code or null
     */
    async resolveToQr(node, floorId) {
        if (!node) return null;
        // 1. Try as QR first
        let cell = await cellService.getCellByQrCode(node, floorId);
        if (cell) return cell.qr_code;

        // 2. Try as Name
        cell = await cellService.getCellByName(node, floorId);
        if (cell && cell.qr_code) return cell.qr_code;

        // 3. Try as Coordinate (e.g., K4, J10)
        // Check if string matches Pattern [Letters][Numbers]
        const coordMatch = node.match(/^([A-Z]+)(\d+)$/);
        if (coordMatch) {
            const colStr = coordMatch[1];
            const row = parseInt(coordMatch[2], 10);

            // Convert column letters to index (A=1, B=2, ..., Z=26, AA=27)
            let col = 0;
            for (let i = 0; i < colStr.length; i++) {
                col = col * 26 + (colStr.charCodeAt(i) - 64); // 'A' is 65
            }

            logger.info(`[Backtrack] Resolving '${node}' as coordinate: Col=${col}, Row=${row}`);
            cell = await cellService.getCellByCoordinate(col, row, floorId);

            // Validation: Try 0-based indexing if 1-based failed (e.g. A=0 instead of A=1)
            if (!cell) {
                const col0 = col - 1;
                logger.info(`[Backtrack] 1-based lookup failed. Trying 0-based col=${col0} for '${node}'`);
                cell = await cellService.getCellByCoordinate(col0, row, floorId);
            }

            if (cell && cell.qr_code) {
                logger.info(`[Backtrack] Resolved Coordinate '${node}' to QR: ${cell.qr_code}`);
                return cell.qr_code;
            }
        }

        return null;
    }

    /**
     * Get backtrack information for a shuttle.
     * 
     * @param {string} shuttleId - ID of shuttle
     * @returns {Promise<object|null>} Backtrack info or null
     */
    async getBacktrackInfo(shuttleId) {
        try {
            const target = await redisClient.get(`shuttle:${shuttleId}:backtrack_target`);
            const steps = await redisClient.get(`shuttle:${shuttleId}:backtrack_steps`);

            if (!target) {
                return null;
            }

            return {
                targetNode: target,
                steps: steps ? parseInt(steps, 10) : 0
            };
        } catch (error) {
            logger.error(`[Backtrack] Error getting backtrack info:`, error);
            return null;
        }
    }
}

module.exports = new BacktrackService();
