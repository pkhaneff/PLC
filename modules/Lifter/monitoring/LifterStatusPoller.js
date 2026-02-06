const LifterPlcReader = require('../plc/LifterPlcReader');
const lifterRedisRepo = require('../redis/LifterRedisRepository');
const eventEmitter = require('../../../socket/events/EventEmitter');
const { logger } = require('../../../config/logger');

class LifterStatusPoller {
    constructor(lifterId, plcId, config) {
        this._lifterId = lifterId;
        this._plcReader = new LifterPlcReader(plcId, config.plcVariables);
        this._pollInterval = config.monitoring.pollInterval;
        this._intervalId = null;
        this._lastFloor = null;
    }

    start() {
        if (this._intervalId) {
            logger.warn(`[LifterPoller] Already running for lifter ${this._lifterId}`);
            return;
        }

        this._intervalId = setInterval(() => this._poll(), this._pollInterval);
        logger.info(`[LifterPoller] Started for lifter ${this._lifterId} (${this._pollInterval}ms)`);
    }

    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
            logger.info(`[LifterPoller] Stopped for lifter ${this._lifterId}`);
        }
    }

    async _poll() {
        try {
            const positions = this._plcReader.readPositions();
            const hasError = this._plcReader.readError();
            const currentFloor = this._plcReader.determineCurrentFloor(positions);

            const status = {
                currentFloor,
                status: this._determineStatus(currentFloor, hasError),
                hasError: !!hasError,
                lastUpdated: new Date().toISOString(),
            };

            const existingStatus = await lifterRedisRepo.getStatus(this._lifterId);
            if (existingStatus?.reservedBy) {
                status.reservedBy = existingStatus.reservedBy;
                status.reservedFloor = existingStatus.reservedFloor;
                status.reservedAt = existingStatus.reservedAt;

                // Auto-release control command when lifter arrives at reserved floor
                if (currentFloor === existingStatus.reservedFloor && currentFloor !== null) {
                    logger.info(`[LifterPoller] Lifter arrived at reserved floor ${currentFloor}, releasing control`);
                    await this._plcReader.releaseControlCommand(currentFloor);
                }
            }

            await lifterRedisRepo.saveStatus(this._lifterId, status);


            if (currentFloor !== this._lastFloor) {
                logger.info(`[LifterPoller] Lifter ${this._lifterId} floor changed: ${this._lastFloor} → ${currentFloor}`);
                this._emitPositionChange(currentFloor);
                this._lastFloor = currentFloor;
            }
        } catch (error) {
            logger.error(`[LifterPoller] Poll error: ${error.message}`);
        }
    }

    _determineStatus(currentFloor, hasError) {
        if (hasError) return 'ERROR';
        if (currentFloor === null) return 'MOVING';
        return 'IDLE';
    }

    _emitPositionChange(floor) {
        eventEmitter.emit('lifter:position_changed', {
            lifterId: this._lifterId,
            currentFloor: floor,
        });
    }
}

module.exports = LifterStatusPoller;
