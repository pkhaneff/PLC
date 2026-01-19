const { logger } = require('../logger/logger');
const { asyncHandler } = require('../middlewares/error.middleware');
const cellService = require('../modules/SHUTTLE/cellService');
const shuttleTaskQueueService = require('../modules/SHUTTLE/shuttleTaskQueueService');
const redisClient = require('../redis/init.redis');
const { findShortestPath } = require('../modules/SHUTTLE/pathfinding');
const { getShuttleState } = require('../modules/SHUTTLE/shuttleStateCache');
const shuttleConfig = require('../config/shuttle.config');
const CellRepository = require('../repository/cell.repository');
const shuttleDispatcherService = require('../modules/SHUTTLE/shuttleDispatcherService');

const TASK_STAGING_QUEUE_KEY = 'task:staging_queue';
const INBOUND_PALLET_QUEUE_KEY = 'shuttle:inbound_pallet_queue';

class ShuttleController {

    // Other methods (findPathSameFloor, etc.) remain unchanged for now
    findPathSameFloor = async (start, end, floor_id) => {
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

    /**
     * Kiểm tra xem ID pallet cùng loại đã tồn tại trong hệ thống chưa (hàng đợi hoặc đang xử lý)
     * @param {string} palletId - ID của pallet cần kiểm tra
     * @param {string} palletType - Loại pallet
     * @returns {Promise<boolean>} True nếu bị trùng
     */
    checkPalletIdDuplicate = async (palletId, palletType) => {
        try {
            // 1. Kiểm tra trong inbound_pallet_queue (Redis List)
            const inboundQueue = await redisClient.lRange(INBOUND_PALLET_QUEUE_KEY, 0, -1);
            for (const itemJson of inboundQueue) {
                const item = JSON.parse(itemJson);
                if (item.palletId === palletId && item.palletType === palletType) {
                    logger.warn(`[Controller] Pallet ID duplicate found in inbound queue: ${palletId}`);
                    return true;
                }
            }

            // 2. Kiểm tra trong task:staging_queue (Redis List)
            const stagingQueue = await redisClient.lRange(TASK_STAGING_QUEUE_KEY, 0, -1);
            for (const itemJson of stagingQueue) {
                const item = JSON.parse(itemJson);
                let id = item.itemInfo;
                if (typeof item.itemInfo === 'object') {
                    id = item.itemInfo.id || item.itemInfo.ID || item.itemInfo.palletId;
                }
                if (id === palletId && item.palletType === palletType) {
                    logger.warn(`[Controller] Pallet ID duplicate found in staging queue: ${palletId}`);
                    return true;
                }
            }

            // 3. Kiểm tra các task đang hiện hữu trong Redis (shuttle:task:*)
            const taskKeys = await redisClient.keys('shuttle:task:*');
            for (const key of taskKeys) {
                const task = await redisClient.hGetAll(key);
                if (task) {
                    let id = task.itemInfo;
                    try {
                        const parsed = JSON.parse(task.itemInfo);
                        if (typeof parsed === 'object') {
                            id = parsed.id || parsed.ID || parsed.palletId || id;
                        }
                    } catch (e) { /* already a string */ }

                    if (id === palletId && task.palletType === palletType) {
                        logger.warn(`[Controller] Pallet ID duplicate found in active task info: ${palletId}`);
                        return true;
                    }
                }
            }

            // 4. Kiểm tra trong database (đã lưu vào cell)
            const isStored = await CellRepository.isPalletIdExists(palletId, palletType);
            if (isStored) {
                logger.warn(`[Controller] Pallet ID duplicate found in database (stored in cell): ${palletId}`);
                return true;
            }

            return false;
        } catch (error) {
            logger.error(`[Controller] Error checking pallet ID duplicate: ${error.message}`);
            throw error;
        }
    };

    /**
     * Giai đoạn 1: Đăng ký Pallet nhập hàng
     * Nhận thông tin pallet và đưa vào hàng đợi chờ xử lý
     */
    registerInbound = asyncHandler(async (req, res) => {
        const { pallet_id, pallet_data } = req.body;

        if (!pallet_id || !pallet_data) {
            return res.status(400).json({
                success: false,
                error: 'Thiếu pallet_id hoặc pallet_data'
            });
        }

        // Kiểm tra trùng ID
        const isDuplicate = await this.checkPalletIdDuplicate(pallet_id, pallet_data);
        if (isDuplicate) {
            return res.status(409).json({
                success: false,
                error: `Pallet ID ${pallet_id} đã tồn tại trong hệ thống (đang chờ xử lý hoặc đã lưu kho)`
            });
        }

        const inboundData = {
            palletId: pallet_id,
            palletType: pallet_data,
            timestamp: Date.now()
        };

        await redisClient.lPush(INBOUND_PALLET_QUEUE_KEY, JSON.stringify(inboundData));

        return res.status(201).json({
            success: true,
            message: 'Pallet đã được ghi nhận vào hàng đợi.',
            data: inboundData
        });
    });

    /**
     * Giai đoạn 2: Kích hoạt nhiệm vụ lưu kho cho một Shuttle cụ thể
     */
    executeStorageTask = asyncHandler(async (req, res) => {
        const { rackId, palletType, shuttle_code } = req.body;

        if (!rackId || !palletType || !shuttle_code) {
            return res.status(400).json({
                success: false,
                error: 'Thiếu rackId, palletType hoặc shuttle_code'
            });
        }

        // 1. Kiểm tra trạng thái shuttle
        const shuttleState = await getShuttleState(shuttle_code);

        if (!shuttleState) {
            return res.status(404).json({
                success: false,
                error: `Không tìm thấy thông tin shuttle ${shuttle_code}`
            });
        }

        if (shuttleState.shuttleStatus !== 8) { // 8 = IDLE
            return res.status(400).json({
                success: false,
                error: `Shuttle ${shuttle_code} đang bận (status: ${shuttleState.shuttleStatus})`
            });
        }

        // 2. Lấy pallet phù hợp từ queue (Duyệt queue tìm loại pallet khớp)
        // Lưu ý: Đơn giản nhất là lấy pallet đầu tiên khớp loại, hoặc FIFO tuyệt đối
        // Ở đây ta sử dụng LPOP và kiểm tra, nếu không khớp thì đẩy lại vào cuối (R-Push)
        // Tuy nhiên để tối ưu, ta có thể duyệt qua danh sách Redis

        const queueLength = await redisClient.lLen(INBOUND_PALLET_QUEUE_KEY);
        let selectedPallet = null;
        let checkedCount = 0;

        while (checkedCount < queueLength) {
            const palletJson = await redisClient.rPop(INBOUND_PALLET_QUEUE_KEY);
            if (!palletJson) break;

            const pallet = JSON.parse(palletJson);
            if (pallet.palletType === palletType) {
                selectedPallet = pallet;
                break;
            } else {
                // Không khớp, đẩy ngược lại vào đầu queue để giữ thứ tự cho các yêu cầu khác
                await redisClient.lPush(INBOUND_PALLET_QUEUE_KEY, palletJson);
                checkedCount++;
            }
        }

        if (!selectedPallet) {
            return res.status(404).json({
                success: false,
                error: `Không tìm thấy pallet loại ${palletType} trong hàng đợi`
            });
        }

        // 3. Khởi tạo nhiệm vụ (Tìm ô trống, khóa ô, và gửi cho dispatcher)
        try {

            // Lấy pickup node từ config
            const config = shuttleConfig.warehouses[rackId];
            if (!config || !config.pickupNodeQr) {
                throw new Error(`Không tìm thấy cấu hình cho Rack ID ${rackId}`);
            }

            const pickupNodeQr = config.pickupNodeQr;
            const cellInfo = await cellService.getCellDeepInfoByQr(pickupNodeQr);
            if (!cellInfo) {
                throw new Error(`QR '${pickupNodeQr}' không tồn tại trong database`);
            }

            const pickupNodeFloorId = cellInfo.floor_id;

            // Tìm ô trống
            const availableNodes = await CellRepository.findAvailableNodesByFIFO(palletType, pickupNodeFloorId);
            if (!availableNodes || availableNodes.length === 0) {
                // Return pallet to queue if no storage available
                await redisClient.lPush(INBOUND_PALLET_QUEUE_KEY, JSON.stringify(selectedPallet));
                return res.status(409).json({
                    success: false,
                    error: `Không còn ô trống cho loại pallet ${palletType} trên tầng ${pickupNodeFloorId}`
                });
            }

            const targetNode = availableNodes[0];

            // Build task object
            const taskId = `man_${Date.now()}_${shuttle_code}`;
            const taskData = {
                taskId: taskId,
                pickupNodeQr: pickupNodeQr,
                pickupNodeFloorId: pickupNodeFloorId,
                endNodeQr: targetNode.qr_code,
                endNodeFloorId: targetNode.floor_id,
                endNodeCol: targetNode.col,
                endNodeRow: targetNode.row,
                palletType: palletType,
                itemInfo: selectedPallet.palletId,
                targetRow: targetNode.row,
                targetFloor: targetNode.floor_id,
                assignedShuttleId: shuttle_code,
                status: 'pending',
                timestamp: Date.now()
            };

            // 4. Lưu chi tiết task vào Redis (Quan trọng: Nếu không lưu, TaskEventListener sẽ bị thiếu dữ liệu khi xử lý event)
            const taskDetailsToSave = { ...taskData };
            if (taskDetailsToSave.itemInfo && typeof taskDetailsToSave.itemInfo === 'object') {
                taskDetailsToSave.itemInfo = JSON.stringify(taskDetailsToSave.itemInfo);
            }
            await redisClient.hSet(shuttleTaskQueueService.getTaskKey(taskId), taskDetailsToSave);

            // 5. Dispatch task trực tiếp cho shuttle được chỉ định
            const dispatcher = new shuttleDispatcherService(req.app.get('io'));
            await dispatcher.dispatchTaskToShuttle(taskData, shuttle_code);

            return res.status(200).json({
                success: true,
                message: `Đã gán nhiệm vụ thành công cho shuttle ${shuttle_code}`,
                data: {
                    taskId: taskId,
                    palletId: selectedPallet.palletId,
                    destination: targetNode.qr_code
                }
            });

        } catch (error) {
            logger.error(`[Controller] Error executing manual storage task: ${error.message}`);
            // Return pallet to queue on internal error
            if (selectedPallet) {
                await redisClient.lPush(INBOUND_PALLET_QUEUE_KEY, JSON.stringify(selectedPallet));
            }
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    autoMode = asyncHandler(async (req, res) => {
        const requestsToProcess = Array.isArray(req.body) ? req.body : [req.body];
        if (!requestsToProcess || requestsToProcess.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing task data in request body.'
            });
        }

        const batchIds = [];
        const errors = [];

        for (const request of requestsToProcess) {
            const { rackId, palletType, listItem } = request;

            // 1. Basic validation
            if (!rackId || !palletType || !listItem || !Array.isArray(listItem) || listItem.length === 0) {
                logger.warn(`[Controller] Skipping invalid request (Missing rackId, palletType, or listItem): ${JSON.stringify(request)}`);
                errors.push({ request, error: 'Thiếu rackId, palletType hoặc listItem' });
                continue;
            }

            // 2. Kiểm tra trùng ID cho từng item trong listItem
            const validItems = [];
            for (const item of listItem) {
                const palletId = typeof item === 'object' ? item.id || item.ID || item.palletId : item;
                const isDuplicate = await this.checkPalletIdDuplicate(palletId, palletType);
                if (isDuplicate) {
                    logger.warn(`[Controller] Skipping duplicate pallet ID ${palletId} in autoMode request`);
                    errors.push({ palletId, error: 'Pallet ID đã tồn tại trong hệ thống' });
                    continue;
                }
                validItems.push(item);
            }

            if (validItems.length === 0) {
                logger.warn(`[Controller] All items in request were duplicates or invalid. Skipping request.`);
                continue;
            }

            // 3. Resolve Pickup Node from Config
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

            // 4. Create master batch
            const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const masterBatch = {
                batchId,
                rackId,
                palletType,
                pickupNodeQr,
                pickupNodeFloorId,
                items: validItems,
                totalItems: validItems.length,
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

            // 5. Trigger batch processing
            await this.processBatchRow(batchId);

            batchIds.push(batchId);
        }

        return res.status(202).json({
            success: true,
            message: 'Batches have been created and are being processed.',
            data: {
                batchIds: batchIds,
                totalBatches: batchIds.length,
                errors: errors.length > 0 ? errors : undefined
            }
        });
    });

    /**
     * Process batch row - tìm row khả dụng và push task vào queue
     * @param {string} batchId - Batch ID
     */
    processBatchRow = async (batchId) => {
        try {

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

        } catch (error) {
            logger.error(`[Controller] Error processing batch row for ${batchId}:`, error);
        }
    };
}

module.exports = new ShuttleController();
