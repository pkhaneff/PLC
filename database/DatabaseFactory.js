const MySQLConnection = require('./implementations/MySQLConnection');
const { logger } = require('../logger/logger');

/**
 * Database Factory - Factory Pattern
 * Tạo database connections dựa trên type và config
 * Tuân thủ Open/Closed Principle - dễ dàng mở rộng cho database types mới
 */
class DatabaseFactory {
    constructor() {
        this.instances = new Map();
    }

    /**
     * Tạo database connection
     * @param {string} type - Database type ('mysql', 'postgresql', etc.)
     * @param {Object} config - Database configuration
     * @param {string} instanceName - Tên instance (default: 'default')
     * @returns {Object} Database connection instance
     */
    createConnection(type, config, instanceName = 'default') {
        // Validate config
        this.validateConfig(type, config);

        // Check if instance already exists
        const key = `${type}_${instanceName}`;
        if (this.instances.has(key)) {
            return this.instances.get(key);
        }

        // Create new instance based on type
        let connection;
        switch (type.toLowerCase()) {
            case 'mysql':
                connection = new MySQLConnection(config);
                break;

            case 'postgresql':
                // Future implementation
                throw new Error('PostgreSQL not yet implemented');

            case 'mongodb':
                // Future implementation
                throw new Error('MongoDB not yet implemented');

            default:
                throw new Error(`Unsupported database type: ${type}`);
        }

        // Store instance
        this.instances.set(key, connection);

        return connection;
    }

    /**
     * Validate database configuration
     * @param {string} type - Database type
     * @param {Object} config - Configuration object
     * @throws {Error} If config is invalid
     */
    validateConfig(type, config) {
        if (!config) {
            throw new Error('Database configuration is required');
        }

        switch (type.toLowerCase()) {
            case 'mysql':
                this.validateMySQLConfig(config);
                break;

            default:
                // Basic validation for other types
                if (!config.host) {
                    throw new Error('Database host is required');
                }
        }
    }

    /**
     * Validate MySQL configuration
     * @param {Object} config - MySQL config
     * @throws {Error} If config is invalid
     */
    validateMySQLConfig(config) {
        const required = ['host', 'user', 'password', 'database'];

        for (const field of required) {
            if (!config[field]) {
                throw new Error(`MySQL configuration missing required field: ${field}`);
            }
        }

        // Validate types
        if (config.connectionLimit && typeof config.connectionLimit !== 'number') {
            throw new Error('connectionLimit must be a number');
        }

        if (config.queueLimit !== undefined && typeof config.queueLimit !== 'number') {
            throw new Error('queueLimit must be a number');
        }
    }

    /**
     * Lấy existing connection instance
     * @param {string} type - Database type
     * @param {string} instanceName - Instance name
     * @returns {Object|null} Connection instance or null
     */
    getInstance(type, instanceName = 'default') {
        const key = `${type}_${instanceName}`;
        return this.instances.get(key) || null;
    }

    /**
     * Đóng tất cả connections
     */
    async closeAll() {

        const closePromises = [];
        for (const [key, connection] of this.instances.entries()) {
            closePromises.push(connection.close());
        }

        await Promise.all(closePromises);
        this.instances.clear();

    }

    /**
     * Đóng một connection cụ thể
     * @param {string} type - Database type
     * @param {string} instanceName - Instance name
     */
    async closeConnection(type, instanceName = 'default') {
        const key = `${type}_${instanceName}`;
        const connection = this.instances.get(key);

        if (connection) {
            await connection.close();
            this.instances.delete(key);
        }
    }

    /**
     * Kiểm tra health của tất cả connections
     * @returns {Promise<Object>} Health status của tất cả connections
     */
    async checkHealth() {
        const health = {};

        for (const [key, connection] of this.instances.entries()) {
            try {
                health[key] = await connection.isHealthy();
            } catch (error) {
                health[key] = false;
            }
        }

        return health;
    }
}

// Export singleton instance
module.exports = new DatabaseFactory();
