const DIContainer = require('./DIContainer');
const DatabaseFactory = require('../database/DatabaseFactory');
const dbConfig = require('../database/DatabaseConfig');
const CellRepository = require('../repository/cell.repository');
const LifterService = require('../modules/Lifter/lifterService');
const { logger } = require('../config/logger');

/**
 * Bootstrap application with Dependency Injection.
 * Initialize and configure all dependencies.
 */

const _container = new DIContainer();

try {
  // ==================== DATABASE ====================

  /**
   * Register database connection
   */
  _container.register(
    'db',
    () => {
      logger.info('[Bootstrap] Initializing database connection...');
      const connection = DatabaseFactory.createConnection(dbConfig.type, dbConfig.config, 'default');
      return connection;
    },
    true,
  ); // Singleton

  // ==================== REPOSITORIES ====================

  /**
   * Register CellRepository
   */
  _container.register(
    'cellRepository',
    (c) => {
      logger.info('[Bootstrap] Initializing CellRepository...');
      const db = c.resolve('db');
      return new CellRepository(db);
    },
    true,
  ); // Singleton

  // ==================== SERVICES ====================

  /**
   * Register LifterService
   */
  _container.register(
    'lifterService',
    (c) => {
      const db = c.resolve('db');
      return new LifterService(db);
    },
    true,
  ); // Singleton

  // ==================== CLEANUP ====================

  /**
   * Graceful shutdown handler
   */
  const gracefulShutdown = async (signal) => {
    try {
      logger.info(`[Bootstrap] Shutdown signal received: ${signal}`);
      // Dispose container (will close all services)
      await _container.dispose();

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
  logger.error('[Bootstrap] Initialization failed:', error);
  process.exit(1);
}

// ==================== EXPORTS ====================

/**
 * Export container for advanced usage
 */
module.exports = _container;

/**
 * Export initialized instances for backward compatibility.
 * Allows old files to import directly.
 */
module.exports.db = _container.resolve('db');
module.exports.cellRepository = _container.resolve('cellRepository');
module.exports.lifterService = _container.resolve('lifterService');
