const waitStateRepo = require('./ShuttleWaitStateRepository');
const { logger } = require('../../../config/logger');

class ShuttleWaitStateService {
    async setWaitState(shuttleId, waitContext) {
        const { waitNodeQr, reason, resumePath, targetLifterFloor } = waitContext;

        const context = {
            reason,
            waitNodeQr,
            targetLifterFloor,
            resumePath: {
                fromQr: waitNodeQr,
                toQr: resumePath.toQr,
                toFloorId: resumePath.toFloorId,
                isCarrying: resumePath.isCarrying,
                taskId: resumePath.taskId,
                pickupNodeQr: resumePath.pickupNodeQr,
                endNodeQr: resumePath.endNodeQr,
            },
        };

        const success = await waitStateRepo.setWaitState(shuttleId, context);
        if (success) {
            logger.info(`[WaitStateService] Shuttle ${shuttleId} set to wait at ${waitNodeQr}`);
        }

        return success;
    }

    async getWaitContext(shuttleId) {
        return await waitStateRepo.getWaitState(shuttleId);
    }

    async clearWaitState(shuttleId) {
        const success = await waitStateRepo.clearWaitState(shuttleId);
        if (success) {
            logger.info(`[WaitStateService] Cleared wait state for ${shuttleId}`);
        }
        return success;
    }

    async isWaiting(shuttleId) {
        const state = await waitStateRepo.getWaitState(shuttleId);
        return state?.isWaiting === true;
    }

    async getAllWaitingShuttles() {
        return await waitStateRepo.getAllWaitingShuttles();
    }
}

module.exports = new ShuttleWaitStateService();
