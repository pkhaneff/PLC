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
        const CellRepository = require('../repository/cell.repository');
        const batchIds = [];

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

            logger.info(`[Controller] Creating batch for ${listItem.length} items (Rack ${rackId}, Floor ${pickupNodeFloorId})`);

            // 4. Create master batch
            const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const masterBatch = {
                batchId,
                rackId,
                palletType,
                pickupNodeQr,
                pickupNodeFloorId,
                items: listItem,
                totalItems: listItem.length,
                processedItems: 0,
                currentRow: null,
                status: 'pending',
                createdAt: Date.now()
            };

            await redisClient.set(
                `batch:master:${batchId}`,
                JSON.stringify(masterBatch),
                { EX: 3600 } // TTL 1 hour
            );

            // 4a. Initialize atomic processed items counter
            await redisClient.set(`batch:${batchId}:processed_items`, 0, { EX: 3600 });

            logger.info(`[Controller] Created master batch ${batchId} with ${listItem.length} items`);

            // 5. Trigger batch processing
            await this.processBatchRow(batchId);

            batchIds.push(batchId);
        }

        return res.status(202).json({
            success: true,
            message: 'Batches have been created and are being processed.',
            data: {
                batchIds: batchIds,
                totalBatches: batchIds.length
            }
        });
    });

    /**
     * Process batch row - tìm row khả dụng và push task vào queue
     * @param {string} batchId - Batch ID
     */
    processBatchRow = async (batchId) => {
        try {
            const CellRepository = require('../repository/cell.repository');

            // 1. Lấy master batch
            const masterBatchData = await redisClient.get(`batch:master:${batchId}`);
            if (!masterBatchData) {
                logger.error(`[Controller] Master batch ${batchId} not found`);
                return;
            }

            const batch = JSON.parse(masterBatchData);

            // 2. Tính số item còn lại dựa trên atomic counter
            const processedCount = await redisClient.get(`batch:${batchId}:processed_items`) || 0;
            const remainingItems = batch.items.slice(parseInt(processedCount, 10));

            if (remainingItems.length === 0) {
                // Hết item, đánh dấu hoàn thành
                batch.status = 'completed';
                await redisClient.set(`batch:master:${batchId}`, JSON.stringify(batch), { EX: 3600 });
                logger.info(`[Controller] Batch ${batchId} completed`);
                return;
            }

            // 3. Tìm row khả dụng theo FIFO
            const availableNodesInRow = await CellRepository.findAvailableNodesByFIFO(
                batch.palletType,
                batch.pickupNodeFloorId
            );

            if (!availableNodesInRow || availableNodesInRow.length === 0) {
                logger.warn(`[Controller] No available nodes for batch ${batchId}, will retry later`);
                // Schedule retry sau 10 giây
                setTimeout(() => this.processBatchRow(batchId), 10000);
                return;
            }

            const targetRow = availableNodesInRow[0].row;
            const targetFloor = availableNodesInRow[0].floor_id;
            const nodeCount = availableNodesInRow.length;

            // 4. So sánh và lấy số lượng item phù hợp
            const itemsToPush = remainingItems.slice(0, Math.min(remainingItems.length, nodeCount));

            logger.info(`[Controller] Batch ${batchId}: Pushing ${itemsToPush.length} tasks to row ${targetRow} (${nodeCount} nodes available)`);

            // 5. Push task vào staging queue
            for (const item of itemsToPush) {
                const taskToStage = {
                    batchId,
                    pickupNodeQr: batch.pickupNodeQr,
                    pickupNodeFloorId: batch.pickupNodeFloorId,
                    itemInfo: item,
                    palletType: batch.palletType,
                    rackId: batch.rackId,
                    targetRow: targetRow,
                    targetFloor: targetFloor
                };

                await redisClient.lPush(TASK_STAGING_QUEUE_KEY, JSON.stringify(taskToStage));
            }

            // 6. Set row counter
            await redisClient.set(`batch:${batchId}:row_counter`, itemsToPush.length);

            // 7. Update master batch
            batch.currentRow = targetRow;
            batch.status = 'processing_row';
            await redisClient.set(`batch:master:${batchId}`, JSON.stringify(batch), { EX: 3600 });

            logger.info(`[Controller] Batch ${batchId}: Pushed ${itemsToPush.length} tasks for row ${targetRow}, row_counter set`);

        } catch (error) {
            logger.error(`[Controller] Error processing batch row for ${batchId}:`, error);
        }
    };
}

module.exports = new ShuttleController();
