const { logger } = require('../../../../config/logger');
const redisClient = require('../../../../redis/init.redis');
const shuttleTaskQueueService = require('../redis/shuttleTaskQueueService');
const { lifterService } = require('../../../../core/bootstrap');
const MissionCoordinatorService = require('../../services/MissionCoordinatorService');
const mqttClientService = require('../../../../services/mqttClientService');
const { TASK_ACTIONS, MQTT_TOPICS } = require('../../../../config/shuttle.config');
const LifterCoordinationService = require('../../../Lifter/LifterCoordinationService');

class LifterEventHandler {
    async handleLifterEvent(payload, dispatcher) {
        const { event, floorId, shuttleId } = payload;
        logger.info(`[LifterEventHandler] Received Redis event: ${event} for F${floorId}`);

        if (event === 'LIFTER_ARRIVED') {
            const waitingKey = `waiting:lifter:${floorId}`;
            const waitingShuttles = await redisClient.sMembers(waitingKey);

            if (waitingShuttles && waitingShuttles.length > 0) {
                logger.info(
                    `[LifterEventHandler] Found ${waitingShuttles.length} shuttles waiting for Lifter at F${floorId}. Resuming...`
                );

                for (const sId of waitingShuttles) {
                    if (dispatcher) {
                        const taskInfo = await shuttleTaskQueueService.getShuttleTask(sId);
                        if (taskInfo) {
                            logger.info(`[LifterEventHandler] Resuming task ${taskInfo.taskId} for shuttle ${sId}`);
                            await dispatcher.dispatchTaskToShuttle(taskInfo, sId);
                            await redisClient.sRem(waitingKey, sId);
                        } else {
                            logger.warn(`[LifterEventHandler] Shuttle ${sId} waiting but no active task found.`);
                            await redisClient.sRem(waitingKey, sId);
                        }
                    }
                }
            }
        }
    }

    async handleWaitingForLifter(shuttleId, eventPayload, dispatcher) {
        const { waitingFloor: floor } = eventPayload.meta || {};
        if (!floor) return;

        logger.info(`[LifterEventHandler] Shuttle ${shuttleId} is WAITING for Lifter at F${floor}.`);
        await redisClient.sAdd(`waiting:lifter:${floor}`, shuttleId);

        // Check if lifter is ALREADY there
        const lifterStatus = await LifterCoordinationService.getLifterStatus();
        const isLifterAtFloor = lifterStatus && String(lifterStatus.currentFloor) === String(floor);
        const isLifterBusy = lifterStatus && lifterStatus.status === 'MOVING';

        if (isLifterAtFloor && !isLifterBusy) {
            logger.info(
                `[LifterEventHandler] Lifter already at F${floor} and idle. Resuming shuttle ${shuttleId} immediately.`
            );

            if (dispatcher) {
                const taskInfo = await shuttleTaskQueueService.getShuttleTask(shuttleId);
                if (taskInfo) {
                    logger.info(`[LifterEventHandler] Immediate Resume: Resuming task ${taskInfo.taskId} for shuttle ${shuttleId}`);
                    await dispatcher.dispatchTaskToShuttle(taskInfo, shuttleId);
                    await redisClient.sRem(`waiting:lifter:${floor}`, shuttleId);
                }
            }
        }
    }

    async handleArrivedAtLifter(shuttleId, eventPayload, dispatcher) {
        try {
            const { finalTargetQr, finalTargetFloorId, taskId, isCarrying } = eventPayload.meta || {};
            if (!finalTargetFloorId || !taskId) {
                logger.error(`[LifterEventHandler] ARRIVED_AT_LIFTER missing meta data for ${shuttleId}`);
                return;
            }

            logger.info(
                `[LifterEventHandler] Shuttle ${shuttleId} arrived at Lifter. Calling lifter to target floor ${finalTargetFloorId}.`
            );

            const moveResult = await lifterService.moveLifterToFloor(finalTargetFloorId);
            if (!moveResult.success) {
                throw new Error(`Failed to move lifter: ${moveResult.message}`);
            }

            logger.info(
                `[LifterEventHandler] Lifter reached floor ${finalTargetFloorId}. Shuttle ${shuttleId} recalculating final leg.`
            );

            // SYNC REDIS STATUS: Crucial for lookahead system
            const LIFTER_STATUS_KEY = 'lifter:status';
            await redisClient.hSet(LIFTER_STATUS_KEY, {
                status: 'IDLE',
                currentFloor: finalTargetFloorId,
                targetFloor: '',
                assignedTo: '',
            });
            logger.debug(`[LifterEventHandler] Synced Redis Lifter status to F${finalTargetFloorId}`);

            const targetArrivalEvent = isCarrying ? 'TASK_COMPLETE' : 'PICKUP_COMPLETE';
            const targetAction = isCarrying ? TASK_ACTIONS.DROP_OFF : TASK_ACTIONS.PICK_UP;

            const missionPayload = await MissionCoordinatorService.calculateNextSegment(
                shuttleId,
                finalTargetQr,
                finalTargetFloorId,
                {
                    taskId: taskId,
                    onArrival: targetArrivalEvent,
                    isCarrying: isCarrying,
                    action: targetAction,
                    currentFloorId: finalTargetFloorId,
                }
            );

            const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;
            if (dispatcher && dispatcher.publishMissionWithRetry) {
                await dispatcher.publishMissionWithRetry(missionTopic, missionPayload, shuttleId);
            } else {
                mqttClientService.publishToTopic(missionTopic, missionPayload);
            }
        } catch (error) {
            logger.error(`[LifterEventHandler] Error in handleArrivedAtLifter for ${shuttleId}: ${error.message}`);
        }
    }
}

module.exports = new LifterEventHandler();
