const eventEmitter = require('../EventEmitter');
const { PLC_EVENTS } = require('../EventTypes');
const { logger } = require('../../../config/logger');

class PLCEventHandler {
    emitProcessingComplete(resultData) {
        const { taskId, plcId, message, data, timestamp } = resultData;

        return eventEmitter.emit(PLC_EVENTS.PROCESSING_COMPLETE, {
            taskId,
            plcId,
            message,
            data,
            timestamp: timestamp || Date.now(),
        });
    }

    emitProcessingError(errorData) {
        const { taskId, plcId, error, timestamp } = errorData;

        return eventEmitter.emit(PLC_EVENTS.PROCESSING_ERROR, {
            taskId,
            plcId,
            error,
            timestamp: timestamp || Date.now(),
        });
    }

    emitStatusUpdated(statusData) {
        const { plcId, status, ...additionalData } = statusData;

        return eventEmitter.emit(PLC_EVENTS.STATUS_UPDATED, {
            plcId,
            status,
            ...additionalData,
        });
    }
}

module.exports = new PLCEventHandler();
