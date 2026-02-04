const socketServer = require('../core/SocketServer');
const { logger } = require('../../config/logger');

class EventEmitter {
    constructor() {
        this._server = socketServer;
    }

    emit(eventType, payload = {}) {
        try {
            const enrichedPayload = {
                ...payload,
                timestamp: payload.timestamp || Date.now(),
            };

            const success = this._server.emit(eventType, enrichedPayload);

            if (success) {
                logger.debug(`[EventEmitter] Emitted: ${eventType}`, {
                    eventType,
                    payloadKeys: Object.keys(enrichedPayload),
                });
            }

            return success;
        } catch (error) {
            logger.error(`[EventEmitter] Failed to emit ${eventType}:`, error);
            return false;
        }
    }

    emitWithLog(eventType, payload = {}, logLevel = 'info') {
        const message = `[EventEmitter] ${eventType}`;
        const logData = { eventType, ...payload };

        switch (logLevel) {
            case 'debug':
                logger.debug(message, logData);
                break;
            case 'warn':
                logger.warn(message, logData);
                break;
            case 'error':
                logger.error(message, logData);
                break;
            default:
                logger.info(message, logData);
        }

        return this.emit(eventType, payload);
    }
}

module.exports = new EventEmitter();
