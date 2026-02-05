require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const {
  initializeSocket,
  mqttEventHandler,
  plcEventHandler
} = require('./socket');
const routes = require('./api/routes/index');
const { notFoundHandler, errorHandler } = require('./middlewares');
const plcManager = require('./modules/PLC/plcManager');
const { plcsConfig } = require('./modules/PLC/configPLC');
const healthController = require('./controllers/health.controller');
const { logger } = require('./config/logger.js');
const shuttleDispatcherService = require('./modules/SHUTTLE/services/shuttleDispatcherService');
const taskEventListener = require('./modules/SHUTTLE/services/TaskEventListener');
const { initializeMqttClient } = require('./services/mqttClientService');
const { initializeMqttBroker } = require('./services/mqttService');
const PathCacheService = require('./modules/SHUTTLE/services/PathCacheService');
const { setEventHandler: setWorkerEventHandler } = require('./middlewares/workerProcessor.middleware');

const app = express();
const server = http.createServer(app);
const io = initializeSocket(server);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

routes(app);

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  try {
    await plcManager.initializeMultiplePLCs(plcsConfig);

    setWorkerEventHandler(plcEventHandler);

    healthController.setInitialized(true);
    logger.info('[Server] All PLCs initialized successfully!');

    await PathCacheService.initialize();

    const dispatcher = new shuttleDispatcherService();

    initializeMqttClient(mqttEventHandler);
    initializeMqttBroker(mqttEventHandler);

    taskEventListener.initialize();
    taskEventListener.setDispatcher(dispatcher);

    server.listen(PORT, () => {
      dispatcher.startDispatcher();
      logger.info(`[Server] Server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('[Server] Failed to start:', error);
  }
}

process.on('SIGINT', () => {
  PathCacheService.stopAutoCleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  PathCacheService.stopAutoCleanup();
  process.exit(0);
});

startServer();
