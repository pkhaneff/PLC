const workerManager = require('../worker/workerManager');
const { logger } = require('../logger/logger')


async function processWorkerTask(taskId, plcId, io) {
    try {

        const result = await workerManager.executeTask(taskId, plcId, 'fetch_data', {
            plcId,
            delay: 3000
        });

        if (result.status === 'success') {

            io.emit('plc-processing-complete', {
                taskId,
                plcId: result.plcId,
                message: result.data.message,
                data: result.data.data,
                timestamp: result.timestamp
            });
        }

    } catch (error) {
        logger.error(`[WorkerProcessorMiddleware] Task ${taskId} failed:`, error);

        io.emit('plc-processing-error', {
            taskId,
            plcId,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = { processWorkerTask };
