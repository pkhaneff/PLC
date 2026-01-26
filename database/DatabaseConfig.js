require('dotenv').config();

/**
 * Database Configuration
 * Centralized configuration cho database connections
 * Chỉ support dev environment
 */

const dbConfig = {
  type: 'mysql',
  config: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'abcd1234',
    database: process.env.DB_NAME || 'wcs',
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    queueLimit: parseInt(process.env.DB_QUEUE_LIMIT) || 0,
  },
};

/**
 * Validate database configuration
 * @throws {Error} If configuration is invalid
 */
function validateConfig() {
  const { config } = dbConfig;

  if (!config.host) {
    throw new Error('Database host is not configured');
  }

  if (!config.user) {
    throw new Error('Database user is not configured');
  }

  if (!config.password) {
    throw new Error('Database password is not configured');
  }

  if (!config.database) {
    throw new Error('Database name is not configured');
  }
}

// Validate on load
validateConfig();

module.exports = dbConfig;
