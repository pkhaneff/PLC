const { logger } = require('../../logger/logger');
const redisClient = require('../../redis/init.redis');
const { getShuttleState } = require('./shuttleStateCache');

/**
 * Service for calculating shuttle priority in conflict resolution.
 * 
 * Priority Formula:
 * priority = (isCarrying ? 1,000,000 : 0) + (999,999 - taskId) + waitingTime
 * 
 * Rules:
 * 1. Shuttles carrying cargo have highest priority (1M+ points)
 * 2. Among same cargo status, lower task ID = higher priority (FIFO)
 * 3. Waiting time is tie-breaker (longer wait = slightly higher priority)
 */
class PriorityCalculationService {

    /**
     * Calculate priority score for a shuttle.
     * 
     * @param {string} shuttleId - The shuttle ID (e.g., "001")
     * @param {object} taskInfo - Task information containing taskId and cargo status
     * @param {number} taskInfo.taskId - The task ID (lower = higher priority)
     * @param {boolean} taskInfo.isCarrying - Whether shuttle is carrying cargo
     * @param {number} [waitingTime=0] - Time shuttle has been waiting in ms
     * @returns {Promise<number>} Priority score (higher = higher priority)
     */
    async calculatePriority(shuttleId, taskInfo, waitingTime = 0) {
        try {
            // Get shuttle state to check if carrying cargo
            const shuttleState = await getShuttleState(shuttleId);

            // Determine if carrying cargo
            let isCarrying = false;
            if (taskInfo && typeof taskInfo.isCarrying === 'boolean') {
                isCarrying = taskInfo.isCarrying;
            } else if (shuttleState && shuttleState.isCarrying) {
                isCarrying = shuttleState.isCarrying;
            }

            // Get task ID
            const taskId = taskInfo?.taskId || 0;

            // Calculate priority components
            // 1. Cargo: 1 Billion points
            const cargoWeight = isCarrying ? 1000000000 : 0;

            // 2. Task Order: Inverted TaskID.
            const taskWeight = 999999 - taskId;

            // NO WAITING TIME per user instructions.
            const priority = cargoWeight + taskWeight;

            logger.debug(`[PriorityCalc] Shuttle ${shuttleId}: cargo=${isCarrying}, taskId=${taskId} → priority=${priority}`);

            // Cache in Redis
            await this.updatePriorityInRedis(shuttleId, priority);

            return priority;
        } catch (error) {
            logger.error(`[PriorityCalc] Error calculating priority for shuttle ${shuttleId}:`, error);
            return 0;
        }
    }

    /**
     * Compare priorities of two shuttles.
     * 
     * @param {string} shuttle1Id - First shuttle ID
     * @param {object} task1Info - First shuttle's task info
     * @param {string} shuttle2Id - Second shuttle ID
     * @param {object} task2Info - Second shuttle's task info
     * @returns {Promise<object>} Comparison result
     */
    async comparePriority(shuttle1Id, task1Info, shuttle2Id, task2Info) {
        try {
            // Get waiting times from Redis if available
            const wait1 = await this.getWaitingTime(shuttle1Id);
            const wait2 = await this.getWaitingTime(shuttle2Id);

            const priority1 = await this.calculatePriority(shuttle1Id, task1Info, wait1);
            const priority2 = await this.calculatePriority(shuttle2Id, task2Info, wait2);

            const result = {
                shuttle1: {
                    id: shuttle1Id,
                    priority: priority1,
                    isCarrying: task1Info?.isCarrying || false,
                    taskId: task1Info?.taskId || 0
                },
                shuttle2: {
                    id: shuttle2Id,
                    priority: priority2,
                    isCarrying: task2Info?.isCarrying || false,
                    taskId: task2Info?.taskId || 0
                },
                winner: priority1 > priority2 ? shuttle1Id : shuttle2Id,
                loser: priority1 > priority2 ? shuttle2Id : shuttle1Id,
                priorityDifference: Math.abs(priority1 - priority2)
            };

            logger.info(`[PriorityCalc] Comparison: ${shuttle1Id}(${priority1}) vs ${shuttle2Id}(${priority2}) → Winner: ${result.winner}`);

            return result;
        } catch (error) {
            logger.error(`[PriorityCalc] Error comparing priorities:`, error);
            throw error;
        }
    }

    /**
     * Update shuttle priority in Redis cache.
     * 
     * @param {string} shuttleId - The shuttle ID
     * @param {number} priority - The priority score
     * @returns {Promise<boolean>} Success status
     */
    async updatePriorityInRedis(shuttleId, priority) {
        try {
            const key = `shuttle:${shuttleId}:priority`;
            await redisClient.set(key, priority.toString(), { EX: 300 }); // Expire after 5 minutes
            return true;
        } catch (error) {
            logger.error(`[PriorityCalc] Error updating priority in Redis for ${shuttleId}:`, error);
            return false;
        }
    }

    /**
     * Get shuttle priority from Redis cache.
     * 
     * @param {string} shuttleId - The shuttle ID
     * @returns {Promise<number|null>} Cached priority or null
     */
    async getPriorityFromRedis(shuttleId) {
        try {
            const key = `shuttle:${shuttleId}:priority`;
            const priority = await redisClient.get(key);
            return priority ? parseInt(priority, 10) : null;
        } catch (error) {
            logger.error(`[PriorityCalc] Error getting priority from Redis for ${shuttleId}:`, error);
            return null;
        }
    }

    /**
     * Get waiting time for a shuttle from Redis.
     * 
     * @param {string} shuttleId - The shuttle ID
     * @returns {Promise<number>} Waiting time in ms (0 if not waiting)
     */
    async getWaitingTime(shuttleId) {
        try {
            const key = `shuttle:${shuttleId}:waiting_since`;
            const waitingSince = await redisClient.get(key);

            if (!waitingSince) {
                return 0;
            }

            const waitingSinceTimestamp = parseInt(waitingSince, 10);
            const now = Date.now();
            const waitingTime = now - waitingSinceTimestamp;

            return Math.max(0, waitingTime);
        } catch (error) {
            logger.error(`[PriorityCalc] Error getting waiting time for ${shuttleId}:`, error);
            return 0;
        }
    }

    /**
     * Determine which shuttle should yield in a conflict.
     * 
     * @param {string} shuttle1Id - First shuttle ID
     * @param {object} task1Info - First shuttle's task info
     * @param {string} shuttle2Id - Second shuttle ID
     * @param {object} task2Info - Second shuttle's task info
     * @returns {Promise<object>} Decision result
     */
    async determineYield(shuttle1Id, task1Info, shuttle2Id, task2Info) {
        const comparison = await this.comparePriority(shuttle1Id, task1Info, shuttle2Id, task2Info);

        return {
            shouldYield: comparison.loser,
            shouldContinue: comparison.winner,
            reason: this.getYieldReason(comparison),
            priorityDifference: comparison.priorityDifference
        };
    }

    /**
     * Get human-readable reason for yield decision.
     * 
     * @param {object} comparison - Comparison result
     * @returns {string} Reason string
     */
    getYieldReason(comparison) {
        const winner = comparison.shuttle1.id === comparison.winner ? comparison.shuttle1 : comparison.shuttle2;
        const loser = comparison.shuttle1.id === comparison.loser ? comparison.shuttle1 : comparison.shuttle2;

        if (winner.isCarrying && !loser.isCarrying) {
            return `${winner.id} is carrying cargo`;
        }

        if (winner.isCarrying === loser.isCarrying && winner.taskId < loser.taskId) {
            return `${winner.id} has earlier task (${winner.taskId} < ${loser.taskId})`;
        }

        return `${winner.id} has higher priority (${winner.priority} > ${loser.priority})`;
    }

    /**
     * Clear priority cache for a shuttle.
     * 
     * @param {string} shuttleId - The shuttle ID
     * @returns {Promise<boolean>} Success status
     */
    async clearPriority(shuttleId) {
        try {
            const key = `shuttle:${shuttleId}:priority`;
            await redisClient.del(key);
            logger.debug(`[PriorityCalc] Cleared priority cache for ${shuttleId}`);
            return true;
        } catch (error) {
            logger.error(`[PriorityCalc] Error clearing priority for ${shuttleId}:`, error);
            return false;
        }
    }
}

module.exports = new PriorityCalculationService();
