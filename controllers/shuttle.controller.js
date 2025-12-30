const { logger } = require('../logger/logger');
const { asyncHandler } = require('../middlewares/error.middleware');
const { findShortestPath } = require('../modules/SHUTTLE/pathfinding');
const cellService = require('../modules/SHUTTLE/cellService');
const shuttleTaskQueueService = require('../modules/SHUTTLE/shuttleTaskQueueService'); // New import

class ShuttleController {
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

    autoMode = asyncHandler(async (req, res) => {
        const tasksToProcess = Array.isArray(req.body) ? req.body : [req.body];
        console.log("=======================================================",tasksToProcess)
        if (!tasksToProcess || tasksToProcess.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing task data in request body. Provide a task object or an array of task objects.'
            });
        }

        const allRegisteredTasks = [];
        for (const task of tasksToProcess) {
            console.log('[Controller] Processing received task:', JSON.stringify(task));
            const { pickupNode, floorId, listItem } = task;
            
            // Convert logical floorId to database floorId
            const databaseFloorId = await cellService.getFloorIdByLogicalNumber(floorId);
            if (databaseFloorId === null) {
                return res.status(404).json({
                    success: false,
                    error: `Logical floor number '${floorId}' not found or invalid.`
                });
            }
            const pickupNodeFloorId = databaseFloorId; // Use the converted ID
            
            if (!pickupNode || !listItem || !Array.isArray(listItem) || listItem.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: `Task missing required parameters (pickupNode, floorId, listItem as non-empty array) or invalid format. Task: ${JSON.stringify(task)}`
                });
            }

            // ---- Start: Add validation for pickupNode existence ----
            const pickupCell = await cellService.getCellByName(pickupNode, pickupNodeFloorId);
            if (!pickupCell) {
                return res.status(404).json({
                    success: false,
                    error: `Pickup node '${pickupNode}' not found on floor ${pickupNodeFloorId}.`   
                });
            }
            // ---- End: Add validation ----

            const endNodeCell = await cellService.findNextEmptyCellFIFO();

            if (!endNodeCell) {
                return res.status(404).json({
                    success: false,
                    error: `No available empty storage cell (end_node) found for task: ${JSON.stringify(task)}`
                });
            }

            const endNode = endNodeCell.qr_code;
            logger.info(`[autoMode] Found end_node for pickupNode ${pickupNode} (Floor ${pickupNodeFloorId}): ${endNode}`);

            // 2. Simulate external device signals (This part might be irrelevant for task creation)
            logger.info(`[autoMode] Sending signal to external devices: Gập ray và mở cổng kho.`);

            // 3. Register task to shuttle task queue for EACH item in listItem
            for (const item of listItem) {
                const registrationResult = await shuttleTaskQueueService.registerTask({
                    pickupNode,
                    pickupNodeFloorId, 
                    endNode,
                    itemInfo: item,
                    endNodeCol: endNodeCell.col, 
                    endNodeRow: endNodeCell.row, 
                    endNodeFloorId: endNodeCell.floor_id 
                });
                allRegisteredTasks.push(registrationResult);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Auto mode tasks successfully registered and queued.',
            data: allRegisteredTasks 
        });
    });
}

module.exports = new ShuttleController();
