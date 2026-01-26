const { logger } = require('../logger/logger');

logger.warn('[DEPRECATED] config/database.js is deprecated. Please use core/bootstrap.js instead.');

const bootstrap = require('../core/bootstrap');

module.exports = bootstrap.db;
