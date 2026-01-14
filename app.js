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
const {logger} = require('./logger/logger.js')
const shuttleDispatcherService = require('./modules/SHUTTLE/shuttleDispatcherService');
const taskEventListener = require('./modules/SHUTTLE/taskEventListener');
const { initializeMqttBroker } = require('./services/mqttService');
const PathCacheService = require('./modules/SHUTTLE/PathCacheService');

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
        // logger.debug('[Server] Initializing PLCs...');
        // await plcManager.initializeMultiplePLCs(plcsConfig);
        // healthController.setInitialized(true);
        // logger.info('[Server] All PLCs initialized successfully!');

        // Initialize 3-Pillar System
        logger.info('[Server] Initializing 3-Pillar Intelligent Traffic Management System...');
        await PathCacheService.initialize(); // Pillar 1: Traffic Center with auto-cleanup
        logger.info('[Server] Pillar 1 (Traffic Center) initialized ✓');

        const dispatcher = new shuttleDispatcherService(io);

        initializeMqttBroker(io);
        taskEventListener.initialize(); // Initialize the task event listener
        taskEventListener.setDispatcher(dispatcher); // Link dispatcher to listener

        server.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT}!`)
            logger.info(`WebSocket is ready!`)
            logger.info('[Server] 3-Pillar System fully operational ✓');
            dispatcher.startDispatcher();
        });
    } catch (error) {
        logger.error('[Server] Failed to start:', error);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('[Server] Shutting down gracefully...');
    PathCacheService.stopAutoCleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('[Server] SIGTERM received, shutting down...');
    PathCacheService.stopAutoCleanup();
    process.exit(0);
});

startServer();
