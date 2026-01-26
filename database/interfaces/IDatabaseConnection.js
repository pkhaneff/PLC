/**
 * @interface IDatabaseConnection
 * @description Interface định nghĩa contract cho database connection.
 * Tuân thủ Dependency Inversion Principle - phụ thuộc vào abstraction thay vì concrete implementation.
 */

/**
 * Thực thi một SQL query và trả về kết quả
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Promise resolves to [rows, fields]
 */
// query(sql, params)

/**
 * Thực thi một prepared statement
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Promise resolves to [rows, fields]
 */
// execute(sql, params)

/**
 * Lấy một connection từ pool
 * @returns {Promise<Object>} Promise resolves to connection object
 */
// getConnection()

/**
 * Bắt đầu một transaction
 * @returns {Promise<Object>} Promise resolves to transaction object
 */
// beginTransaction()

/**
 * Commit transaction
 * @param {Object} connection - Connection object
 * @returns {Promise<void>}
 */
// commit(connection)

/**
 * Rollback transaction
 * @param {Object} connection - Connection object
 * @returns {Promise<void>}
 */
// rollback(connection)

/**
 * Đóng connection pool
 * @returns {Promise<void>}
 */
// close()

/**
 * Kiểm tra connection health
 * @returns {Promise<boolean>} Promise resolves to true if healthy
 */
// isHealthy()

module.exports = {};
