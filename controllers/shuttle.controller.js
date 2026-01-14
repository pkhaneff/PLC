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
                error: 'Missing task data in request body.'
            });
        }

        // Load configuration
        const shuttleConfig = require('../config/shuttle.config');
        let preparedTasksCount = 0;
        const stagingPromises = [];

        for (const request of requestsToProcess) {
            const { rackId, palletType, listItem } = request;

            // 1. Basic validation
            if (!rackId || !palletType || !listItem || !Array.isArray(listItem) || listItem.length === 0) {
                logger.warn(`[Controller] Skipping invalid request (Missing rackId, palletType, or listItem): ${JSON.stringify(request)}`);
                continue;
            }

            // 2. Resolve Pickup Node from Config
            const config = shuttleConfig.warehouses[rackId];
            if (!config || !config.pickupNodeQr) {
                logger.warn(`[Controller] No configuration found for Rack ID ${rackId}. Skipping request.`);
                continue;
            }

            const pickupNodeQr = config.pickupNodeQr;

            // 3. Resolve context from QR (Auto-find Floor and verify Rack)
            const cellInfo = await cellService.getCellDeepInfoByQr(pickupNodeQr);
            if (!cellInfo) {
                logger.error(`[Controller] Pickup QR '${pickupNodeQr}' not found in database. Skipping.`);
                continue;
            }

            // Optional Safety check: Does the QR actually belong to the rackId requested?
            if (cellInfo.rack_id != rackId) {
                logger.warn(`[Controller] Config mismatch: QR ${pickupNodeQr} belongs to Rack ${cellInfo.rack_id}, but request specified Rack ${rackId}. Skipping.`);
                continue;
            }

            const pickupNodeFloorId = cellInfo.floor_id;

            logger.info(`[Controller] Staging ${listItem.length} items for Rack ${rackId} starting at ${pickupNodeQr} (Floor ${pickupNodeFloorId})`);

            // 4. Staging
            for (const item of listItem) {
                const taskToStage = {
                    pickupNodeQr,
                    pickupNodeFloorId,
                    itemInfo: item,
                    palletType: palletType,
                    rackId: rackId // Pass rackId along for downstream config lookups
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
