const mysql = require('mysql2/promise');
const { logger } = require('../../config/logger');

/**
 * MySQL implementation của IDatabaseConnection interface
 * Implements Dependency Inversion Principle
 */
class MySQLConnection {
  /**
   * @param {Object} config - MySQL configuration object
   */
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.isInitialized = false;
  }

  /**
   * Khởi tạo connection pool
   * @private
   */
  async initialize() {
    if (this.isInitialized) {
      return;
    }

    try {
      this.pool = mysql.createPool({
        host: this.config.host,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        waitForConnections: this.config.waitForConnections !== undefined ? this.config.waitForConnections : true,
        connectionLimit: this.config.connectionLimit || 10,
        queueLimit: this.config.queueLimit !== undefined ? this.config.queueLimit : 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      });

      // Test connection
      const connection = await this.pool.getConnection();
      connection.release();

      this.isInitialized = true;
    } catch (error) {
      logger.error('[MySQLConnection] Error initializing database connection:', error.message);
      throw error;
    }
  }

  /**
   * Đảm bảo pool đã được khởi tạo
   * @private
   */
  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Thực thi SQL query
   * @param {string} sql - SQL query string
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>} [rows, fields]
   */
  async query(sql, params = []) {
    await this.ensureInitialized();

    try {
      const [rows, fields] = await this.pool.query(sql, params);
      return [rows, fields];
    } catch (error) {
      logger.error('[MySQLConnection] Query error:', error.message);
      logger.error('[MySQLConnection] SQL:', sql);
      throw error;
    }
  }

  /**
   * Thực thi prepared statement
   * @param {string} sql - SQL query string
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>} [rows, fields]
   */
  async execute(sql, params = []) {
    await this.ensureInitialized();

    try {
      const [rows, fields] = await this.pool.execute(sql, params);
      return [rows, fields];
    } catch (error) {
      logger.error('[MySQLConnection] Execute error:', error.message);
      logger.error('[MySQLConnection] SQL:', sql);
      throw error;
    }
  }

  /**
   * Lấy connection từ pool
   * @returns {Promise<Object>} Connection object
   */
  async getConnection() {
    await this.ensureInitialized();

    try {
      return await this.pool.getConnection();
    } catch (error) {
      logger.error('[MySQLConnection] Error getting connection:', error.message);
      throw error;
    }
  }

  /**
   * Bắt đầu transaction
   * @returns {Promise<Object>} Connection object with transaction started
   */
  async beginTransaction() {
    const connection = await this.getConnection();

    try {
      await connection.beginTransaction();
      return connection;
    } catch (error) {
      connection.release();
      logger.error('[MySQLConnection] Error beginning transaction:', error.message);
      throw error;
    }
  }

  /**
   * Commit transaction
   * @param {Object} connection - Connection object
   */
  async commit(connection) {
    try {
      await connection.commit();
      connection.release();
    } catch (error) {
      logger.error('[MySQLConnection] Error committing transaction:', error.message);
      throw error;
    }
  }

  /**
   * Rollback transaction
   * @param {Object} connection - Connection object
   */
  async rollback(connection) {
    try {
      await connection.rollback();
      connection.release();
    } catch (error) {
      logger.error('[MySQLConnection] Error rolling back transaction:', error.message);
      throw error;
    }
  }

  /**
   * Đóng connection pool
   */
  async close() {
    if (this.pool) {
      try {
        await this.pool.end();
        this.isInitialized = false;
        logger.info('[MySQLConnection] Database connection pool closed');
      } catch (error) {
        logger.error('[MySQLConnection] Error closing connection pool:', error.message);
        throw error;
      }
    }
  }

  /**
   * Kiểm tra connection health
   * @returns {Promise<boolean>}
   */
  async isHealthy() {
    if (!this.isInitialized) {
      return false;
    }

    try {
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();
      return true;
    } catch (error) {
      logger.error('[MySQLConnection] Health check failed:', error.message);
      return false;
    }
  }
}

module.exports = MySQLConnection;
