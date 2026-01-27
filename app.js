require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const initializeSocket = require('./socket/socket.js');
const routes = require('./api/routes/index');
const { notFoundHandler, errorHandler } = require('./middlewares');
const plcManager = require('./modules/PLC/plcManager');
const { plcsConfig } = require('./modules/PLC/configPLC');
const healthController = require('./controllers/health.controller');
const { logger } = require('./logger/logger.js');
const shuttleDispatcherService = require('./modules/SHUTTLE/services/shuttleDispatcherService');
const taskEventListener = require('./modules/SHUTTLE/services/TaskEventListener');
const { initializeMqttClient } = require('./services/mqttClientService');
const PathCacheService = require('./modules/SHUTTLE/services/PathCacheService');

const app = express();
const server = http.createServer(app);
const io = initializeSocket(server);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('io', io);

routes(app);

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  try {
    await plcManager.initializeMultiplePLCs(plcsConfig);
    healthController.setInitialized(true);
    logger.info('[Server] All PLCs initialized successfully!');

    // Initialize 3-Pillar System
    await PathCacheService.initialize(); // Pillar 1: Traffic Center with auto-cleanup

    const dispatcher = new shuttleDispatcherService(io);

    initializeMqttClient(io);
    taskEventListener.initialize();
    taskEventListener.setDispatcher(dispatcher);

    server.listen(PORT, () => {
      dispatcher.startDispatcher();
    });
  } catch (error) {
    logger.error('[Server] Failed to start:', error);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  PathCacheService.stopAutoCleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  PathCacheService.stopAutoCleanup();
  process.exit(0);
});

startServer();
