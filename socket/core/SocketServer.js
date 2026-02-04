const { Server } = require('socket.io');
const { logger } = require('../../config/logger');

class SocketServer {
    constructor() {
        this._io = null;
        this._server = null;
        this._config = {
            cors: {
                origin: '*',
                methods: ['GET', 'POST'],
            },
        };
    }

    initialize(httpServer, config = {}) {
        if (this._io) {
            logger.warn('[SocketServer] Already initialized');
            return this._io;
        }

        this._server = httpServer;
        this._config = { ...this._config, ...config };
        this._io = new Server(this._server, this._config);

        logger.info('[SocketServer] Socket.IO server initialized');
        return this._io;
    }

    getIO() {
        if (!this._io) {
            throw new Error('[SocketServer] Socket.IO not initialized. Call initialize() first.');
        }
        return this._io;
    }

    isInitialized() {
        return this._io !== null;
    }

    emit(event, data) {
        if (!this._io) {
            logger.error('[SocketServer] Cannot emit: Socket.IO not initialized');
            return false;
        }
        this._io.emit(event, data);
        return true;
    }

    close() {
        if (this._io) {
            this._io.close();
            this._io = null;
            logger.info('[SocketServer] Socket.IO server closed');
        }
    }
}

module.exports = new SocketServer();
