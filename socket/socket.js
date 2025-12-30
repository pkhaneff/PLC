const { Server } = require('socket.io');
const {logger} = require('../logger/logger')
const socketConfig = {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
};

function setupSocketEvents(io) {
    const originalEmit = io.emit.bind(io);
    io.emit = function(event, ...args) {
        return originalEmit(event, ...args);
    };

    io.on('connection', (socket) => {
        logger.info('=== WEBSOCKET CONNECTION ===');
        logger.info(`[WebSocket] Total clients: ${io.engine.clientsCount}`);
        logger.info(`[WebSocket] Client IP: ${socket.handshake.address}`);
        logger.info('=======================');

        socket.on('disconnect', (reason) => {
            logger.info('=== WEBSOCKET DISCONNECTION ===');
            logger.info(`[WebSocket] Client disconnected: ${socket.id}`);
            logger.info('=======================');
        });

        socket.on('error', (error) => {
            logger.info('=== WEBSOCKET ERROR ===');
            logger.info(`[WebSocket] Error on socket ${socket.id}:`, error);
            logger.info('=======================');
        });
    });

    return io;
}

function initializeSocket(server) {
    const io = new Server(server, socketConfig);
    return setupSocketEvents(io);
}

module.exports = initializeSocket;
