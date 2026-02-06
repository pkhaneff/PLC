const LifterPlcReader = require('../plc/LifterPlcReader');
const { lifter: lifterConfig } = require('../../../config/shuttle.config');
const { logger } = require('../../../config/logger');

class LifterMoveController {
    constructor(plcId = 'PLC_1') {
        this._plcReader = new LifterPlcReader(plcId, lifterConfig.plcVariables);
        this._plcId = plcId;
    }

    async moveToFloor(targetFloor) {
        try {
            const positions = this._plcReader.readPositions();
            const currentFloor = this._plcReader.determineCurrentFloor(positions);

            if (currentFloor === targetFloor) {
                logger.info(`[LifterMoveCtrl] Already at floor ${targetFloor}`);
                return { success: true, alreadyThere: true };
            }

            const success = await this._plcReader.sendControlCommand(targetFloor);
            if (!success) {
                throw new Error('Failed to send control command');
            }

            logger.info(`[LifterMoveCtrl] Move command sent to floor ${targetFloor}`);
            return { success: true, alreadyThere: false };
        } catch (error) {
            logger.error(`[LifterMoveCtrl] Move error: ${error.message}`);
            throw error;
        }
    }

    async waitForArrival(targetFloor, timeout = 30000) {
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
                const positions = this._plcReader.readPositions();
                const currentFloor = this._plcReader.determineCurrentFloor(positions);
                const hasError = this._plcReader.readError();

                if (hasError) {
                    clearInterval(checkInterval);
                    reject(new Error('Lifter error detected'));
                    return;
                }

                if (currentFloor === targetFloor) {
                    clearInterval(checkInterval);
                    this._plcReader.releaseControlCommand(targetFloor);
                    resolve({ success: true, floor: currentFloor });
                    return;
                }

                if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    reject(new Error('Lifter move timeout'));
                }
            }, 500);
        });
    }
}

module.exports = LifterMoveController;
