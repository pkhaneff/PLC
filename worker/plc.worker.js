const { parentPort, workerData } = require('worker_threads');
const { logger } = require('../logger/logger')
const { plcId: workerPlcId } = workerData;


parentPort.on('message', async (message) => {
    const { taskId, action, data } = message;


    try {
        let result;

        switch (action) {
            case 'fetch_data':
                result = await fetchPLCData(data);
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }

        parentPort.postMessage({
            taskId,
            plcId: workerPlcId,
            status: 'success',
            data: result,
            timestamp: new Date().toISOString()
        });


    } catch (error) {
        parentPort.postMessage({
            taskId,
            plcId: workerPlcId,
            status: 'error',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        logger.warn(`[PLCWorker:${workerPlcId}] Task ${taskId} failed:`, error.message);
    }
});

async function fetchPLCData(taskData) {
    const { delay = 3000, plcId } = taskData;


    await setPLCActive(plcId || workerPlcId, false);

    logger.debug(`[PLCWorker:${workerPlcId}] Waiting ${delay}ms before fetching values...`);
    await sleep(delay);

    const apiUrl = `http://localhost:${process.env.PORT || 3000}/api/v1/plc/${plcId || workerPlcId}/values`;
    logger.debug(`[PLCWorker:${workerPlcId}] Calling API: ${apiUrl}`);

    const response = await fetch(apiUrl);

    if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
    }

    const data = await response.json();

    await setPLCActive(plcId || workerPlcId, true);


    return {
        plcId: plcId || workerPlcId,
        message: 'PLC data loaded successfully',
        data: data,
        timestamp: new Date().toISOString()
    };
}

async function setPLCActive(plcId, isActive) {
    try {
        const apiUrl = `http://localhost:${process.env.PORT || 3000}/api/v1/plc/${plcId}/active`;

        logger.debug(`[PLCWorker:${workerPlcId}] Set PLC ${plcId} active=${isActive}`);
    } catch (error) {
        logger.error(`[PLCWorker:${workerPlcId}] Failed to set PLC active:`, error.message);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGTERM', () => {
    logger.debug(`[PLCWorker:${workerPlcId}] Received SIGTERM, shutting down...`);
    parentPort.close();
});

process.on('SIGINT', () => {
    logger.debug(`[PLCWorker:${workerPlcId}] Received SIGINT, shutting down...`);
    parentPort.close();
});
