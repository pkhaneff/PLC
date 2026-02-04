const { logger } = require('../../../config/logger');

class AMRLogger {
    static dispatcher(message, data = {}) {
        logger.info(`[AMR-Dispatcher] ${message}`, data);
    }

    static reservation(message, data = {}) {
        logger.info(`[AMR-Reservation] ${message}`, data);
    }

    static conflict(message, data = {}) {
        logger.warn(`[AMR-Conflict] ${message}`, data);
    }

    static traffic(message, data = {}) {
        logger.info(`[AMR-Traffic] ${message}`, data);
    }

    static queue(message, data = {}) {
        logger.info(`[AMR-Queue] ${message}`, data);
    }

    static state(message, data = {}) {
        logger.info(`[AMR-State] ${message}`, data);
    }

    static error(module, message, error) {
        logger.error(`[AMR-${module}] ${message}`, {
            error: error.message,
            stack: error.stack
        });
    }

    static debug(module, message, data = {}) {
        logger.debug(`[AMR-${module}] ${message}`, data);
    }
}

module.exports = AMRLogger;
