const { logger } = require('../../config/logger');
const { SYSTEM_EVENTS } = require('../events/EventTypes');

class ConnectionManager {
    constructor() {
        this._connections = new Map();
        this._io = null;
    }

    initialize(io) {
        if (this._io) {
            logger.warn('[ConnectionManager] Already initialized');
            return;
        }

        this._io = io;
        this._setupEventHandlers();
        logger.info('[ConnectionManager] Initialized');
    }

    _setupEventHandlers() {
        this._io.on('connection', (socket) => {
            this._handleConnection(socket);
        });
    }

    _handleConnection(socket) {
        const clientId = socket.id;
        this._connections.set(clientId, {
            id: clientId,
            connectedAt: Date.now(),
            address: socket.handshake.address,
        });

        logger.info(`[ConnectionManager] Client connected: ${clientId}`);

        socket.on('disconnect', (reason) => {
            this._handleDisconnection(clientId, reason);
        });

        socket.on('error', (error) => {
            this._handleError(clientId, error);
        });
    }

    _handleDisconnection(clientId, reason) {
        this._connections.delete(clientId);
        logger.info(`[ConnectionManager] Client disconnected: ${clientId}, reason: ${reason}`);
    }

    _handleError(clientId, error) {
        logger.error(`[ConnectionManager] Socket error for ${clientId}:`, error);
    }

    getConnectionCount() {
        return this._connections.size;
    }

    getConnections() {
        return Array.from(this._connections.values());
    }

    isConnected(clientId) {
        return this._connections.has(clientId);
    }

    getConnectionStats() {
        return {
            total: this._connections.size,
            connections: this.getConnections(),
        };
    }
}

module.exports = new ConnectionManager();
