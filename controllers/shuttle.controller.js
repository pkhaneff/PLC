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
            const { pickupNodeQr, rackId, floorId, listItem } = request;

            // Updated validation for IDs and QRs
            if (!rackId || !floorId || !pickupNodeQr || !listItem || !Array.isArray(listItem) || listItem.length === 0) {
                logger.warn(`[Controller] Skipping invalid task request: ${JSON.stringify(request)}`);
                continue;
            }

            // Validate rack and floor relationship using IDs
            const isValidRackFloor = await cellService.validateRackFloor(rackId, floorId);
            if (!isValidRackFloor) {
                logger.warn(`[Controller] Invalid relationship between Rack ID ${rackId} and Floor ID ${floorId}. Skipping request.`);
                continue;
            }

            const pickupNodeFloorId = floorId;

            // Validate pickup node using QR code
            // Note: getCellByQrCode checks if cell exists on specific floor
            const pickupCell = await cellService.getCellByQrCode(pickupNodeQr, pickupNodeFloorId);
            if (!pickupCell) {
                logger.warn(`[Controller] Pickup node QR '${pickupNodeQr}' not found on floor ${pickupNodeFloorId}. Skipping request.`);
                continue;
            }

            // Enrich logging with names for human readability
            const logName = await cellService.enrichLogWithNames(pickupNodeQr, floorId);
            logger.info(`[Controller] Processing request for ${logName}`);

            // For each item in the request, create a separate task in the staging queue
            for (const item of listItem) {
                logger.info(`[Controller] Staging item: "${item}" for pickupNode ${pickupNodeQr}.Pushing to ${TASK_STAGING_QUEUE_KEY}.`);
                const taskToStage = {
                    pickupNodeQr,    // Using QR code
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
