const workerManager = require('../worker/workerManager');
const { logger } = require('../config/logger');

let _plcEventHandler = null;

function setEventHandler(plcEventHandler) {
  _plcEventHandler = plcEventHandler;
}

async function processWorkerTask(taskId, plcId) {
  try {
    const result = await workerManager.executeTask(taskId, plcId, 'fetch_data', {
      plcId,
      delay: 3000,
    });

    if (result.status === 'success' && _plcEventHandler) {
      _plcEventHandler.emitProcessingComplete({
        taskId,
        plcId: result.plcId,
        message: result.data.message,
        data: result.data.data,
        timestamp: result.timestamp,
      });
    }
  } catch (error) {
    logger.error(`[WorkerProcessorMiddleware] Task ${taskId} failed:`, error);

    if (_plcEventHandler) {
      _plcEventHandler.emitProcessingError({
        taskId,
        plcId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

module.exports = { processWorkerTask, setEventHandler };
