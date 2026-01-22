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

            // --- NEW: LOOKAHEAD LOGIC FOR LIFTER ---
            // ONLY apply when cross-floor movement is required
            if (isCrossFloor) {
                // Scan path for Lifter Node (T4/X5555Y5555)
                const LIFTER_NODE_QR = 'X5555Y5555';
                let lifterIndex = -1;

                // fullPath.steps contains step1, step2...
                // We need to iterate to find the LIFTER_NODE_QR
                for (let i = 1; i <= fullPath.totalStep; i++) {
                    const stepStr = fullPath[`step${i}`];
                    if (stepStr && stepStr.startsWith(LIFTER_NODE_QR)) {
                        lifterIndex = i;
                        break;
                    }
                }

                if (lifterIndex !== -1) {
                    // Path crosses Lifter Node
                    const LifterCoordinationService = require('../Lifter/LifterCoordinationService');
                    const lifterStatus = await LifterCoordinationService.getLifterStatus();

                    // Check if we need to wait
                    // Wait if: Lifter is NOT at current floor OR Lifter is busy moving
                    // Note: If Lifter is at current floor but Status is MOVING (to another floor?), we should wait.
                    // But getLifterStatus returns Redis status.
                    const isLifterAtFloor = lifterStatus && String(lifterStatus.currentFloor) === String(currentFloorId);
                    const isLifterMoving = lifterStatus && lifterStatus.status === 'MOVING';

                    if (!isLifterAtFloor || isLifterMoving) {
                        logger.info(`[MissionCoordinator] Lifter Lookahead: Lifter not ready at F${currentFloorId} (Status: ${lifterStatus?.status}, Floor: ${lifterStatus?.currentFloor}). Requesting...`);

                        // 1. Request Lifter
                        await LifterCoordinationService.requestLifter(currentFloorId, shuttleId, 1);

                        // 2. Truncate Path
                        // We must stop BEFORE entering the Lifter.
                        // Lifter is at lifterIndex. We stop at lifterIndex - 1.
                        const stopIndex = lifterIndex - 1;

                        if (stopIndex < 1) {
                            // We are AT the neighbor already.
                            // Path length 0? No, we just stay put?
                            // If stopIndex < 1, it means the very next step is Lifter.
                            // But calculateNextSegment implies we are moving FROM somewhere.
                            // If we are already at neighbor, findShortestPath(neighbor, target) -> step1 is Lifter.
                            // So stopIndex = 0.
                            // We return a "WAIT" mission (no movement).
                            logger.info(`[MissionCoordinator] Shuttle ${shuttleId} is already at entry. Waiting for Lifter.`);
                            return {
                                totalStep: 0,
                                running_path_simulation: [],
                                meta: {
                                    taskId: options.taskId,
                                    onArrival: 'WAITING_FOR_LIFTER',
                                    step: 'wait_for_lifter',
                                    finalTargetQr: finalTargetQr,
                                    finalTargetFloorId: finalTargetFloorId,
                                    pickupNodeQr: options.pickupNodeQr,
                                    endNodeQr: options.endNodeQr,
                                    itemInfo: options.itemInfo,
                                    isCarrying: options.isCarrying,
                                    waitingFloor: currentFloorId
                                }
                            };
                        }

                        // Truncate path logic
                        const truncatedPath = {
                            totalStep: stopIndex
                        };
                        const truncatedSimulation = [];

                        for (let i = 1; i <= stopIndex; i++) {
                            truncatedPath[`step${i}`] = fullPath[`step${i}`];
                            const qr = fullPath[`step${i}`].split('>')[0];
                            truncatedSimulation.push(qr);
                        }

                        // Set Last Step Action to STOP
                        // The loop above copies the string "QR>DIR:ACTION".
                        // We might want to overwrite the action of the last step to STOP/No Action
                        // But usually standard move is fine, it just ends there.

                        return {
                            ...truncatedPath,
                            running_path_simulation: truncatedSimulation,
                            meta: {
                                taskId: options.taskId,
                                onArrival: 'WAITING_FOR_LIFTER', // Special status
                                step: 'move_to_lifter_entry',
                                finalTargetQr: finalTargetQr,
                                finalTargetFloorId: finalTargetFloorId,
                                pickupNodeQr: options.pickupNodeQr,
                                endNodeQr: options.endNodeQr,
                                itemInfo: options.itemInfo,
                                isCarrying: options.isCarrying,
                                waitingFloor: currentFloorId
                            }
                        };
                    }
                }
            }
            // --- END LOOKAHEAD ---

            const pathSteps = fullPath.steps || fullPath;

            // Tạo running_path_simulation từ pathSteps
            const runningPathSimulation = [];
            for (let i = 1; i <= pathSteps.totalStep; i++) {
                const stepString = pathSteps[`step${i}`];
                if (stepString) {
                    // Extract QR code from "QRCODE>direction:action" format
                    const qrCode = stepString.split('>')[0];
                    runningPathSimulation.push(qrCode);
                }
            }

            // Tạo payload cho mission
            return {
                ...pathSteps,
                running_path_simulation: runningPathSimulation,
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
