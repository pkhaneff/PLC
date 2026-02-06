const LifterStatusPoller = require('./monitoring/LifterStatusPoller');
const lifterRedisRepo = require('./redis/LifterRedisRepository');
const { lifter: lifterConfig } = require('../../config/shuttle.config');
const { logger } = require('../../config/logger');

class LifterMonitoringService {
    constructor() {
        this._pollers = new Map();
    }

    startMonitoring(lifterId = 1, plcId = 'PLC_1') {
        if (this._pollers.has(lifterId)) {
            logger.warn(`[LifterMonitoring] Already monitoring lifter ${lifterId}`);
            return;
        }

        const poller = new LifterStatusPoller(lifterId, plcId, lifterConfig);
        poller.start();
        this._pollers.set(lifterId, poller);

        logger.info(`[LifterMonitoring] Monitoring started for lifter ${lifterId}`);
    }

    stopMonitoring(lifterId) {
        const poller = this._pollers.get(lifterId);
        if (poller) {
            poller.stop();
            this._pollers.delete(lifterId);
            logger.info(`[LifterMonitoring] Monitoring stopped for lifter ${lifterId}`);
        }
    }

    stopAll() {
        for (const [lifterId, poller] of this._pollers.entries()) {
            poller.stop();
            logger.info(`[LifterMonitoring] Stopped monitoring lifter ${lifterId}`);
        }
        this._pollers.clear();
    }

    async getCurrentStatus(lifterId = 1) {
        return await lifterRedisRepo.getStatus(lifterId);
    }

    async reserveLifter(lifterId, shuttleId, targetFloor) {
        return await lifterRedisRepo.reserve(lifterId, shuttleId, targetFloor);
    }

    async releaseReservation(lifterId, shuttleId) {
        return await lifterRedisRepo.releaseReservation(lifterId, shuttleId);
    }
}

module.exports = new LifterMonitoringService();
