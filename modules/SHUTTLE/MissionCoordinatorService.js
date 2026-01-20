const { logger } = require('../../logger/logger');
const { findShortestPath } = require('./pathfinding');
const { getShuttleState } = require('./shuttleStateCache');
const cellService = require('./cellService');
const lifterService = require('../Lifter/lifterService');
const NodeOccupationService = require('./NodeOccupationService');
const PathCacheService = require('./PathCacheService');
const { TASK_ACTIONS } = require('../../config/shuttle.config');

class MissionCoordinatorService {
    /**
     * Tính toán chặng đường tiếp theo cho Shuttle dựa trên đích đến cuối cùng
     * Hỗ trợ cả cùng tầng và khác tầng (thông qua Lifter)
     * 
     * @param {string} shuttleId - ID của shuttle
     * @param {string} finalTargetQr - QR code của đích đến cuối cùng
     * @param {number} finalTargetFloorId - Tầng của đích đến cuối cùng
     * @param {Object} options - Tùy chọn bổ sung (isCarrying, taskId, itemInfo, action)
     * @returns {Promise<Object|null>} Payload của mission để gửi qua MQTT
     */
    async calculateNextSegment(shuttleId, finalTargetQr, finalTargetFloorId, options = {}) {
        try {
            const shuttleState = await getShuttleState(shuttleId);
            if (!shuttleState) {
                throw new Error(`Shuttle ${shuttleId} state not found`);
            }

            const currentQr = shuttleState.current_node || shuttleState.qrCode;

            // Tìm thông tin tầng hiện tại của shuttle
            let currentFloorId = options.currentFloorId;
            if (!currentFloorId) {
                const currentCell = await cellService.getCellDeepInfoByQr(currentQr);
                if (!currentCell) {
                    throw new Error(`Current cell ${currentQr} not found for shuttle ${shuttleId}`);
                }
                currentFloorId = currentCell.floor_id;
            }

            logger.info(`[MissionCoordinator] Calculating path for ${shuttleId}: (${currentQr}, F${currentFloorId}) -> (${finalTargetQr}, F${finalTargetFloorId})`);

            let targetQr = finalTargetQr;
            let targetFloorId = finalTargetFloorId;
            let onArrival = options.onArrival || 'TASK_COMPLETE';
            let lastStepAction = options.action || (onArrival === 'PICKUP_COMPLETE' ? TASK_ACTIONS.PICK_UP : TASK_ACTIONS.DROP_OFF);
            let isCrossFloor = currentFloorId !== finalTargetFloorId;

            // --- LOGIC DI CHUYỂN KHÁC TẦNG ---
            if (isCrossFloor) {
                logger.info(`[MissionCoordinator] Cross-floor mission detected. Redirecting to Lifter.`);

                // 1. Tìm Lifter trên tầng hiện tại
                // Ưu tiên node T4 (X5555Y5555) theo yêu cầu người dùng
                const lifterExitQr = 'X5555Y5555';
                const lifterNodeOnFloor = await cellService.getCellByQrCode(lifterExitQr, currentFloorId);

                let lifterCell = null;
                if (lifterNodeOnFloor) {
                    logger.debug(`[MissionCoordinator] Using designated lifter node ${lifterExitQr} on floor ${currentFloorId}`);
                    lifterCell = lifterNodeOnFloor;
                } else {
                    logger.debug(`[MissionCoordinator] Designated lifter node ${lifterExitQr} not found on floor ${currentFloorId}. Falling back to DB search.`);
                    lifterCell = await lifterService.getLifterCellOnFloor(currentFloorId);
                }

                if (!lifterCell) {
                    throw new Error(`No lifter found on floor ${currentFloorId}`);
                }

                targetQr = lifterCell.qr_code;
                targetFloorId = currentFloorId;
                onArrival = 'ARRIVED_AT_LIFTER';
                lastStepAction = TASK_ACTIONS.STOP_AT_NODE; // Dừng lại ở cửa Lifter
            }

            // --- TÌM ĐƯỜNG A* ---
            const occupiedMap = await NodeOccupationService.getAllOccupiedNodes();
            const avoidNodes = Object.keys(occupiedMap).filter(qr =>
                qr !== currentQr && qr !== targetQr
            );

            const trafficData = await PathCacheService.getAllActivePaths();

            let fullPath = await findShortestPath(
                currentQr,
                targetQr,
                targetFloorId,
                {
                    avoid: avoidNodes,
                    isCarrying: options.isCarrying || false,
                    trafficData: trafficData,
                    lastStepAction: lastStepAction,
                    ...options
                }
            );

            // Fallback nếu có vật cản
            if (!fullPath) {
                logger.warn(`[MissionCoordinator] Soft avoidance failed. Trying direct path.`);
                fullPath = await findShortestPath(
                    currentQr,
                    targetQr,
                    targetFloorId,
                    {
                        isCarrying: options.isCarrying || false,
                        trafficData: trafficData,
                        lastStepAction: lastStepAction,
                        ...options
                    }
                );
            }

            if (!fullPath || !fullPath.totalStep || fullPath.totalStep === 0) {
                throw new Error(`Failed to find path to ${targetQr}`);
            }

            // Lưu path vào cache
            await PathCacheService.savePath(shuttleId, fullPath);

            const pathSteps = fullPath.steps || fullPath;

            // Tạo payload cho mission
            return {
                ...pathSteps,
                meta: {
                    taskId: options.taskId,
                    onArrival: onArrival,
                    step: isCrossFloor ? 'move_to_lifter' : 'move_to_target',
                    finalTargetQr: finalTargetQr,
                    finalTargetFloorId: finalTargetFloorId,
                    pickupNodeQr: options.pickupNodeQr,
                    endNodeQr: options.endNodeQr,
                    itemInfo: options.itemInfo,
                    isCarrying: options.isCarrying
                }
            };

        } catch (error) {
            logger.error(`[MissionCoordinator] Error calculating next segment for ${shuttleId}: ${error.message}`);
            throw error;
        }
    }
}

module.exports = new MissionCoordinatorService();
