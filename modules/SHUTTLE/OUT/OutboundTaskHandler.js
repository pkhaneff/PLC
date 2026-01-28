const { logger } = require('../../../config/logger');
const redisClient = require('../../../redis/init.redis');
const shuttleTaskQueueService = require('../lifter/redis/shuttleTaskQueueService');
const cellService = require('../services/cellService');
const { updateShuttleState, getShuttleState } = require('../lifter/redis/shuttleStateCache');
const MissionCoordinatorService = require('../services/MissionCoordinatorService');
const mqttClientService = require('../../../services/mqttClientService');
const PathCacheService = require('../lifter/redis/PathCacheService');
const { MQTT_TOPICS } = require('../../../config/shuttle.config');

class OutboundTaskHandler {
    /**
     * Xử lý sau khi shuttle lấy hàng từ storage node (pickup complete)
     * @param {string} taskId - Task ID
     * @param {string} shuttleId - Shuttle ID
     * @param {object} dispatcher - Dispatcher instance
     */
    async handlePickupComplete(taskId, shuttleId, dispatcher) {
        const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
        if (!taskDetails) {
            logger.error(`[OutboundHandler] Cannot find details for task ${taskId} after pickup.`);
            return;
        }

        const { pickupNodeQr, pickupNodeFloorId, endNodeQr, endNodeFloorId } = taskDetails;
        const taskKey = shuttleTaskQueueService.getTaskKey(taskId);

        await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
        await redisClient.hSet(taskKey, 'pickupCompleted', 'true');

        // Cập nhật cell: Xóa hàng khỏi pickup node
        const pickupNodeCell = await cellService.getCellByQrCode(pickupNodeQr, pickupNodeFloorId);
        if (pickupNodeCell) {
            await cellService.updateCellHasBox(pickupNodeCell.id, false);
            logger.info(
                `[OutboundHandler] Updated pickup node ${pickupNodeQr}: is_has_box = 0, pallet_id = NULL`
            );
        } else {
            logger.error(
                `[OutboundHandler] Cannot find pickup node cell QR '${pickupNodeQr}' in DB. Cannot update is_has_box.`
            );
        }

        try {
            // Tính toán path đến outNode (end node)
            const missionPayload = await MissionCoordinatorService.calculateNextSegment(
                shuttleId,
                endNodeQr,
                endNodeFloorId,
                {
                    taskId: taskId,
                    onArrival: 'TASK_COMPLETE',
                    pickupNodeQr: pickupNodeQr,
                    endNodeQr: endNodeQr,
                    itemInfo: taskDetails.itemInfo,
                    isCarrying: true,
                    enforceOneWay: false, // Outbound không cần one-way logic
                    ignoreBoxOnNodes: [pickupNodeQr], // Option 1: Bỏ qua node vừa bốc hàng khi tìm đường
                }
            );

            // Cập nhật shuttle package state
            const currentShuttleState = (await getShuttleState(shuttleId)) || {};
            await updateShuttleState(shuttleId, { ...currentShuttleState, isCarrying: true, packageStatus: 1 });
            await redisClient.hSet(taskKey, 'isCarrying', 'true');

            // Gửi mission
            const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;
            if (dispatcher && dispatcher.publishMissionWithRetry) {
                await dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
            } else {
                mqttClientService.publishToTopic(missionTopic, missionPayload);
            }

            logger.info(`[OutboundHandler] Sent mission to shuttle ${shuttleId} to move to outNode ${endNodeQr}`);
        } catch (error) {
            logger.error(`[OutboundHandler] Error in path calculation: ${error.message}`);
            await shuttleTaskQueueService.updateTaskStatus(taskId, 'failed');
        }
    }

    /**
     * Xử lý sau khi shuttle thả hàng tại outNode (task complete)
     * @param {string} taskId - Task ID
     * @param {string} shuttleId - Shuttle ID
     * @param {object} dispatcher - Dispatcher instance
     */
    async handleTaskComplete(taskId, shuttleId, dispatcher) {
        const taskDetails = await shuttleTaskQueueService.getTaskDetails(taskId);
        if (!taskDetails || !taskDetails.endNodeQr || !taskDetails.endNodeFloorId) {
            logger.error(`[OutboundHandler] Cannot find details for completed task ${taskId}.`);
            if (dispatcher) {
                setTimeout(() => dispatcher.dispatchNextTask(), 1000);
            }
            await PathCacheService.deletePath(shuttleId);
            return;
        }

        // Cập nhật task status
        await shuttleTaskQueueService.updateTaskStatus(taskId, 'completed');

        logger.info(
            `[OutboundHandler] Task ${taskId} completed. Pallet delivered to outNode ${taskDetails.endNodeQr}`
        );

        // Cập nhật shuttle state về IDLE
        const currentState = (await getShuttleState(shuttleId)) || {};
        await updateShuttleState(shuttleId, {
            ...currentState,
            shuttleStatus: 8, // IDLE
            packageStatus: 0,
            isCarrying: false,
            current_node: taskDetails.endNodeQr,
            qrCode: taskDetails.endNodeQr,
            taskId: '',
            targetQr: '',
        });

        logger.info(`[OutboundHandler] Shuttle ${shuttleId} returned to IDLE state`);

        // Auto process inbound queue nếu shuttle trong executing mode
        setTimeout(async () => {
            const controller = require('../../../controllers/shuttle.controller');
            const result = await controller.autoProcessInboundQueue(shuttleId);
            if (!result.success) {
                logger.debug(
                    `[OutboundHandler] autoProcessInboundQueue failed (${result.reason}), falling back to dispatchNextTask`
                );
                if (dispatcher) {
                    dispatcher.dispatchNextTask();
                }
            } else {
                logger.info(`[OutboundHandler] Shuttle ${shuttleId} automatically picked up next task from queue`);
            }
        }, 1000);

        await PathCacheService.deletePath(shuttleId);
    }
}

module.exports = new OutboundTaskHandler();
