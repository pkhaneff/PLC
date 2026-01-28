const DIContainer = require('./DIContainer');
const DatabaseFactory = require('../database/DatabaseFactory');
const dbConfig = require('../database/DatabaseConfig');
const CellRepository = require('../repository/cell.repository');
const LifterService = require('../modules/Lifter/lifterService');
const { logger } = require('../config/logger');

/**
 * Bootstrap application với Dependency Injection
 * Khởi tạo và cấu hình tất cả dependencies
 */

const container = new DIContainer();

try {
  // ==================== DATABASE ====================

  /**
   * Register database connection
   */
  container.register(
    'db',
    () => {
      logger.info('[Bootstrap] Initializing database connection...');
      const connection = DatabaseFactory.createConnection(dbConfig.type, dbConfig.config, 'default');
      return connection;
    },
    true
  ); // Singleton

  // ==================== REPOSITORIES ====================

  /**
   * Register CellRepository
   */
  container.register(
    'cellRepository',
    (c) => {
      logger.info('[Bootstrap] Initializing CellRepository...');
      const db = c.resolve('db');
      return new CellRepository(db);
    },
    true
  ); // Singleton

  // ==================== SERVICES ====================

  /**
   * Register LifterService
   */
  container.register(
    'lifterService',
    (c) => {
      const db = c.resolve('db');
      return new LifterService(db);
    },
    true
  ); // Singleton

  // ==================== CLEANUP ====================

  /**
   * Graceful shutdown handler
   */
  const gracefulShutdown = async (signal) => {
    try {
      // Dispose container (will close all services)
      await container.dispose();

      // Close database factory
      await DatabaseFactory.closeAll();

      process.exit(0);
    } catch (error) {
      logger.error('[Bootstrap] Error during shutdown:', error);
      process.exit(1);
    }
  };

  // Register shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
} catch (error) {
  process.exit(1);
}

// ==================== EXPORTS ====================

/**
 * Export container for advanced usage
 */
module.exports = container;

/**
 * Export initialized instances for backward compatibility
 * Cho phép các file cũ vẫn có thể import trực tiếp
 */
module.exports.db = container.resolve('db');
module.exports.cellRepository = container.resolve('cellRepository');
module.exports.lifterService = container.resolve('lifterService');
