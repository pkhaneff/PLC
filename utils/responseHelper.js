
const { HTTP_STATUS } = require('../constants/responseMessages');

const sendSuccess = (res, { action, message, data, statusCode = HTTP_STATUS.OK }) => {
    return res.status(statusCode).json({
        success: true,
        action,
        message,
        data
    });
};

const sendError = (res, { error, statusCode = HTTP_STATUS.BAD_REQUEST }) => {
    return res.status(statusCode).json({
        success: false,
        error
    });
};

const createShuttleData = (shuttleId, options = {}) => {
    return {
        shuttle_id: shuttleId,
        ...options
    };
};

module.exports = {
    sendSuccess,
    sendError,
    createShuttleData
};
