const shuttleWaitState = require('../../SHUTTLE/services/ShuttleWaitStateService');
const lifterMonitoring = require('../LifterMonitoringService');
const MissionCoordinator = require('../../SHUTTLE/services/MissionCoordinatorService');
const { lifter: lifterConfig } = require('../../../config/shuttle.config');
const { logger } = require('../../../config/logger');

class LifterReadyPoller {
    constructor() {
        this._intervalId = null;
        this._pollInterval = lifterConfig.monitoring.pollInterval;
    }

    start() {
        if (this._intervalId) {
            logger.warn('[LifterReadyPoller] Already running');
            return;
        }

        this._intervalId = setInterval(() => this._poll(), this._pollInterval);
        logger.info(`[LifterReadyPoller] Started (${this._pollInterval}ms)`);
    }

    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
            logger.info('[LifterReadyPoller] Stopped');
        }
    }

    async _poll() {
        try {
            const waitingShuttles = await shuttleWaitState.getAllWaitingShuttles();

            for (const shuttle of waitingShuttles) {
                if (shuttle.reason !== 'WAITING_FOR_LIFTER') continue;

                const lifterStatus = await lifterMonitoring.getCurrentStatus(1);
                const targetFloor = shuttle.targetLifterFloor;

                if (lifterStatus?.currentFloor === targetFloor && lifterStatus?.status === 'IDLE') {
                    await this._resumeShuttle(shuttle.shuttleId, shuttle.resumePath);
                }
            }
        } catch (error) {
            logger.error(`[LifterReadyPoller] Poll error: ${error.message}`);
        }
    }

    async _resumeShuttle(shuttleId, resumePath) {
        try {
            logger.info(`[LifterReadyPoller] Resuming shuttle ${shuttleId}`);
            logger.debug(`[LifterReadyPoller] Resume path: ${JSON.stringify(resumePath)}`);

            await lifterMonitoring.releaseReservation(1, shuttleId);
            await shuttleWaitState.clearWaitState(shuttleId);

            const mission = await MissionCoordinator.calculateNextSegment(
                shuttleId,
                resumePath.toQr,
                resumePath.toFloorId,
                {
                    taskId: resumePath.taskId,
                    isCarrying: resumePath.isCarrying,
                    pickupNodeQr: resumePath.pickupNodeQr,
                    endNodeQr: resumePath.endNodeQr,
                    onArrival: resumePath.onArrival,
                },
            );

            if (!mission || mission.totalStep === 0) {
                logger.warn(`[LifterReadyPoller] No valid mission calculated for ${shuttleId}`);
                return;
            }

            // Publish mission to shuttle via MQTT
            const mqttClientService = require('../../../services/mqttClientService');
            const { MQTT_TOPICS } = require('../../../config/shuttle.config');
            const missionTopic = `${MQTT_TOPICS.HANDLE}/${shuttleId}`;

            mqttClientService.publishToTopic(missionTopic, mission);
            logger.info(`[LifterReadyPoller] Resume mission sent to ${shuttleId}`);
        } catch (error) {
            logger.error(`[LifterReadyPoller] Resume error for ${shuttleId}: ${error.message}`);
        }
    }
}

module.exports = new LifterReadyPoller();
