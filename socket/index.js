const socketServer = require('./core/SocketServer');
const connectionManager = require('./core/ConnectionManager');
const eventEmitter = require('./events/EventEmitter');
const amrEventHandler = require('./events/handlers/AMREventHandler');
const shuttleEventHandler = require('./events/handlers/ShuttleEventHandler');
const mqttEventHandler = require('./events/handlers/MQTTEventHandler');
const plcEventHandler = require('./events/handlers/PLCEventHandler');
const { attachSocketService } = require('./middleware/SocketMiddleware');

function initializeSocket(httpServer, config = {}) {
    const io = socketServer.initialize(httpServer, config);
    connectionManager.initialize(io);
    return io;
}

function getSocketIO() {
    return socketServer.getIO();
}

module.exports = {
    initializeSocket,
    getSocketIO,
    socketServer,
    connectionManager,
    eventEmitter,
    amrEventHandler,
    shuttleEventHandler,
    mqttEventHandler,
    plcEventHandler,
    attachSocketService,
};
