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

        const dispatcher = new shuttleDispatcherService(io);

        initializeMqttBroker(io);
        taskEventListener.initialize(); // Initialize the task event listener
        taskEventListener.setDispatcher(dispatcher); // Link dispatcher to listener

        server.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT}!`)
            logger.info(`WebSocket is ready!`)
            dispatcher.startDispatcher(); 
        });
    } catch (error) {
        logger.error('[Server] Failed to start:', error);
    }
}

startServer();
