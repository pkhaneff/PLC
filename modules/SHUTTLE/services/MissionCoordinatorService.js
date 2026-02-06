const { logger } = require('../../../config/logger');
const { findShortestPath } = require('./pathfinding');
const { getShuttleState } = require('./shuttleStateCache');
const cellService = require('./cellService');
const { lifterService } = require('../../../core/bootstrap');
const NodeOccupationService = require('./NodeOccupationService');
const PathCacheService = require('./PathCacheService');
const { TASK_ACTIONS } = require('../../../config/shuttle.config');
const lifterMonitoring = require('../../Lifter/LifterMonitoringService');
const lifterPathAnalyzer = require('../../Lifter/path/LifterPathAnalyzer');
const shuttleWaitState = require('./ShuttleWaitStateService');
const { lifter: lifterConfig } = require('../../../config/shuttle.config');

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

      logger.info(
        `[MissionCoordinator] Calculating path for ${shuttleId}: (${currentQr}, F${currentFloorId}) -> (${finalTargetQr}, F${finalTargetFloorId})`,
      );

      logger.info(
        `[MissionCoordinator] isCrossFloor=${Number(currentFloorId) !== Number(finalTargetFloorId)} (current=${currentFloorId}, target=${finalTargetFloorId})`,
      );

      let targetQr = finalTargetQr;
      let targetFloorId = finalTargetFloorId;
      let onArrival = options.onArrival || 'TASK_COMPLETE';
      let lastStepAction =
        options.action || (onArrival === 'PICKUP_COMPLETE' ? TASK_ACTIONS.PICK_UP : TASK_ACTIONS.DROP_OFF);
      const isCrossFloor = Number(currentFloorId) !== Number(finalTargetFloorId);

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
          logger.debug(
            `[MissionCoordinator] Designated lifter node ${lifterExitQr} not found on floor ${currentFloorId}. Falling back to DB search.`,
          );
          lifterCell = await lifterService.getLifterCellOnFloor(currentFloorId);
        }

        if (!lifterCell) {
          throw new Error(`No lifter found on floor ${currentFloorId}`);
        }

        targetQr = lifterCell.qr_code;
        targetFloorId = currentFloorId;
        onArrival = 'ARRIVED_AT_LIFTER';
        lastStepAction = TASK_ACTIONS.STOP_AT_NODE; // Dừng lại ở cửa Lifter
      } else {
        logger.info(`[MissionCoordinator] Same-floor mission, no lifter needed.`);
      }

      // --- TÌM ĐƯỜNG A* ---
      const occupiedMap = await NodeOccupationService.getAllOccupiedNodes();
      const avoidNodes = Object.keys(occupiedMap).filter((qr) => qr !== currentQr && qr !== targetQr);

      const trafficData = await PathCacheService.getAllActivePaths();

      let fullPath = await findShortestPath(currentQr, targetQr, targetFloorId, {
        avoid: avoidNodes,
        isCarrying: options.isCarrying || false,
        trafficData: trafficData,
        lastStepAction: lastStepAction,
        ...options,
      });

      // Fallback nếu có vật cản
      if (!fullPath) {
        logger.warn(`[MissionCoordinator] Soft avoidance failed. Trying direct path.`);
        fullPath = await findShortestPath(currentQr, targetQr, targetFloorId, {
          isCarrying: options.isCarrying || false,
          trafficData: trafficData,
          lastStepAction: lastStepAction,
          ...options,
        });
      }

      if (!fullPath || !fullPath.totalStep || fullPath.totalStep === 0) {
        throw new Error(`Failed to find path to ${targetQr}`);
      }

      await PathCacheService.savePath(shuttleId, fullPath, {
        taskId: options.taskId,
        isCarrying: options.isCarrying || false,
        endNodeQr: finalTargetQr,
        targetFloorId: finalTargetFloorId,
      });

      // --- LIFTER SAFETY CHECK ---
      // Skip lifter check if shuttle is already at a lifter node (exiting lifter area)
      const isAtLifterNode = lifterConfig.nodes.includes(currentQr);

      if (isAtLifterNode) {
        logger.info(`[MissionCoordinator] Shuttle ${shuttleId} is at lifter node ${currentQr}, skipping lifter check (exiting lifter)`);
      } else {
        // Always check if path goes through lifter area, regardless of cross-floor or same-floor
        logger.info(`[MissionCoordinator] Checking if path intersects with lifter area...`);
        const lifterPreCheck = await this._checkLifterReadiness(
          shuttleId,
          fullPath,
          currentFloorId,
          options,
          finalTargetQr,
          finalTargetFloorId,
          isCrossFloor,
        );

        if (lifterPreCheck.shouldWait) {
          logger.info(`[MissionCoordinator] Shuttle ${shuttleId} will wait for lifter`);
          return lifterPreCheck.payload;
        }
      }

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
          isCarrying: options.isCarrying,
        },
      };
    } catch (error) {
      logger.error(`[MissionCoordinator] Error calculating next segment for ${shuttleId}: ${error.message}`);
      throw error;
    }
  }

  async _checkLifterReadiness(shuttleId, fullPath, currentFloorId, options, finalTargetQr, finalTargetFloorId, isCrossFloor) {
    logger.info(`[MissionCoordinator] Analyzing path for lifter nodes: ${JSON.stringify(lifterConfig.nodes)}`);
    const analysis = lifterPathAnalyzer.analyzePathForLifter(fullPath, lifterConfig.nodes);

    if (!analysis) {
      logger.info(`[MissionCoordinator] Path does not intersect with lifter area, no check needed`);
      return { shouldWait: false };
    }

    // If shuttle is exiting lifter area (lifter node is first step), skip lifter check
    if (analysis.isExiting) {
      logger.info(`[MissionCoordinator] Shuttle ${shuttleId} is exiting lifter area at step 1, skipping lifter check`);
      return { shouldWait: false, isExiting: true };
    }

    // Lifter physically blocks T4 on BOTH floors
    // Must check lifter position for ALL missions passing through (same-floor or cross-floor)
    logger.info(
      `[MissionCoordinator] Path intersects lifter at step ${analysis.lifterIndex}, node: ${analysis.lifterQr} (isCrossFloor=${isCrossFloor})`,
    );

    const lifterStatus = await lifterMonitoring.getCurrentStatus(1);
    const targetFloor = lifterConfig.floorMapping[currentFloorId];

    logger.info(
      `[MissionCoordinator] Lifter check: current=${lifterStatus?.currentFloor}, target=${targetFloor}, status=${lifterStatus?.status}`,
    );

    const isLifterReady =
      lifterStatus && lifterStatus.currentFloor === targetFloor && lifterStatus.status === 'IDLE';

    if (isLifterReady) {
      logger.info(`[MissionCoordinator] Lifter ready at F${targetFloor}, proceeding`);
      return { shouldWait: false };
    }

    logger.info(
      `[MissionCoordinator] Lifter not ready, calling proactively: F${lifterStatus?.currentFloor} → F${targetFloor}`,
    );

    await lifterMonitoring.reserveLifter(1, shuttleId, targetFloor);

    // Convert targetFloor (1,2) to floor_id (138,139) for lifterService
    const floorIdMapping = { 1: 138, 2: 139 };
    const targetFloorId = floorIdMapping[targetFloor];

    // Call lifter immediately (proactive) - don't wait for shuttle to arrive
    logger.info(`[MissionCoordinator] Sending lifter move command to floor ${targetFloor} (floor_id=${targetFloorId})`);
    lifterService.moveLifterToFloor(targetFloorId).catch(err => {
      logger.error(`[MissionCoordinator] Lifter move error: ${err.message}`);
    });

    if (analysis.waitNodeIndex < 1) {
      await shuttleWaitState.setWaitState(shuttleId, {
        waitNodeQr: fullPath[`step1`]?.split('>')[0] || options.currentQr,
        reason: 'WAITING_FOR_LIFTER',
        targetLifterFloor: targetFloor,
        resumePath: {
          toQr: finalTargetQr,
          toFloorId: finalTargetFloorId,
          pickupNodeQr: options.pickupNodeQr,
          endNodeQr: options.endNodeQr,
          taskId: options.taskId,
          isCarrying: options.isCarrying,
          onArrival: options.onArrival,
        },
      });

      return {
        shouldWait: true,
        payload: {
          totalStep: 0,
          running_path_simulation: [],
          meta: {
            taskId: options.taskId,
            onArrival: 'WAITING_FOR_LIFTER',
            step: 'wait_for_lifter',
            finalTargetQr,
            finalTargetFloorId,
            pickupNodeQr: options.pickupNodeQr,
            endNodeQr: options.endNodeQr,
            itemInfo: options.itemInfo,
            isCarrying: options.isCarrying,
            waitingFloor: currentFloorId,
          },
        },
      };
    }

    const truncated = lifterPathAnalyzer.truncatePathToWaitNode(fullPath, analysis.waitNodeIndex);

    await shuttleWaitState.setWaitState(shuttleId, {
      waitNodeQr: analysis.waitNodeQr,
      reason: 'WAITING_FOR_LIFTER',
      targetLifterFloor: targetFloor,
      resumePath: {
        toQr: finalTargetQr,
        toFloorId: finalTargetFloorId,
        pickupNodeQr: options.pickupNodeQr,
        endNodeQr: options.endNodeQr,
        taskId: options.taskId,
        isCarrying: options.isCarrying,
        onArrival: options.onArrival,
      },
    });

    return {
      shouldWait: true,
      payload: {
        ...truncated,
        running_path_simulation: truncated.steps,
        meta: {
          taskId: options.taskId,
          onArrival: 'WAITING_FOR_LIFTER',
          step: 'move_to_wait_position',
          finalTargetQr,
          finalTargetFloorId,
          pickupNodeQr: options.pickupNodeQr,
          endNodeQr: options.endNodeQr,
          itemInfo: options.itemInfo,
          isCarrying: options.isCarrying,
          waitingFloor: currentFloorId,
        },
      },
    };
  }
}

module.exports = new MissionCoordinatorService();
