const { logger } = require('../logger/logger');
const { asyncHandler } = require('../middlewares/error.middleware');
const cellService = require('../modules/SHUTTLE/cellService');
const redisClient = require('../redis/init.redis'); // Import redis client

const TASK_STAGING_QUEUE_KEY = 'task:staging_queue';

class ShuttleController {

    // Other methods (findPathSameFloor, etc.) remain unchanged for now
    findPathSameFloor = async (start, end, floor_id) => {
        const { findShortestPath } = require('../modules/SHUTTLE/pathfinding');
        const listNode = await findShortestPath(start, end, floor_id);

        if (!listNode) {
            throw new Error(`Không tìm thấy đường đi từ ${start} đến ${end} trên tầng ${floor_id}`);
        }

        return listNode;
    };

    findPathCrossFloor = async (start, end, start_floor_id, end_floor_id, lifter_id) => {
    };

    nodeFinding = asyncHandler(async (req, res) => {
    });

    registerShuttle = asyncHandler(async (req, res) => {
    });
    updatePosition = asyncHandler(async (req, res) => {
    });

    autoMode = asyncHandler(async (req, res) => {
        const requestsToProcess = Array.isArray(req.body) ? req.body : [req.body];
        if (!requestsToProcess || requestsToProcess.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing task data in request body. Provide a task object or an array of task objects.'
            });
        }

        let preparedTasksCount = 0;
        const stagingPromises = [];

        for (const request of requestsToProcess) {
            const { pickupNode, rack, floor, listItem } = request;

            // Basic validation
            if (!rack || !floor || !pickupNode || !listItem || !Array.isArray(listItem) || listItem.length === 0) {
                logger.warn(`[Controller] Skipping invalid task request: ${JSON.stringify(request)}`);
                continue;
            }

            // More detailed validation (can be improved)
            const floorInfo = await cellService.getFloorByRackAndFloorName(rack, floor);
            if (!floorInfo) {
                logger.warn(`[Controller] Floor '${floor}' not found in rack '${rack}'. Skipping request.`);
                continue;
            }
            const pickupNodeFloorId = floorInfo.id;
            
            const pickupCell = await cellService.getCellByName(pickupNode, pickupNodeFloorId);
            if (!pickupCell) {
                logger.warn(`[Controller] Pickup node '${pickupNode}' not found on floor ${pickupNodeFloorId}. Skipping request.`);
                continue;
            }

            // For each item in the request, create a separate task in the staging queue
            for (const item of listItem) {
                logger.info(`[Controller] Staging item: "${item}" for pickupNode ${pickupNode}.Pushing to ${TASK_STAGING_QUEUE_KEY}.`);
                const taskToStage = {
                    pickupNode,
                    pickupNodeFloorId,
                    itemInfo: item,
                };
                
                stagingPromises.push(
                    redisClient.lPush(TASK_STAGING_QUEUE_KEY, JSON.stringify(taskToStage))
                );
                preparedTasksCount++;
            }
        }

        try {
            const pushResults = await Promise.all(stagingPromises);
            const successfulPushes = pushResults.filter(r => typeof r === 'number').length;
            logger.info(`[Controller] Redis LPUSH command results: ${pushResults.join(', ')}`);
            logger.info(`[Controller] Prepared ${preparedTasksCount} tasks, successfully pushed ${successfulPushes} tasks.`);

            const currentQueueLength = await redisClient.lLen(TASK_STAGING_QUEUE_KEY);
            logger.info(`[Controller] Verified queue length in Redis: ${currentQueueLength} tasks in ${TASK_STAGING_QUEUE_KEY}.`);

            return res.status(202).json({
                success: true,
                message: 'Tasks have been accepted and are awaiting processing.',
                data: {
                    stagedTasksCount: successfulPushes,
                    queueLength: currentQueueLength,
                }
            });

        } catch (error) {
            logger.error('[Controller] Error during staging tasks to Redis:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to stage tasks due to a Redis error.'
            });
        }
    });
}

module.exports = new ShuttleController();
