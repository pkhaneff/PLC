const plcManager = require('../../PLC/plcManager');
const { logger } = require('../../../config/logger');

class LifterPlcReader {
    constructor(plcId, variables) {
        this._plcId = plcId;
        this._vars = variables;
    }

    readPositions() {
        const posF1 = plcManager.getValue(this._plcId, this._vars.posF1);
        const posF2 = plcManager.getValue(this._plcId, this._vars.posF2);

        return { posF1, posF2 };
    }

    readError() {
        return plcManager.getValue(this._plcId, this._vars.error);
    }

    async sendControlCommand(floor) {
        const ctrlTag = floor === 1 ? this._vars.ctrlF1 : this._vars.ctrlF2;

        logger.info(`[LifterPlcReader] Sending control command: ${ctrlTag}=true`);
        const result = await plcManager.writeValue(this._plcId, ctrlTag, true);

        if (result?.error) {
            logger.error(`[LifterPlcReader] Control write failed: ${result.error}`);
            return false;
        }

        return true;
    }

    async releaseControlCommand(floor) {
        const ctrlTag = floor === 1 ? this._vars.ctrlF1 : this._vars.ctrlF2;
        return await plcManager.writeValue(this._plcId, ctrlTag, false);
    }

    determineCurrentFloor(positions) {
        if (positions.posF1) return 1;
        if (positions.posF2) return 2;
        return null;
    }
}

module.exports = LifterPlcReader;
