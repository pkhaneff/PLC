const pool = require('../config/database');
const { logger } = require('../logger/logger');

/**
 * Repository for all database interactions with the 'cells' table.
 */
class CellRepository {

  /**
   * Finds a batch of available 'endNode' cells, sorted by the spatial FIFO rule.
   * An available cell is one that is not blocked and does not contain a box.
   * 
   * Spatial FIFO order: by floor (bottom to top), then by row, then by column.
   * 
   * @param {number} page - The page number to retrieve (1-indexed).
   * @param {number} pageSize - The number of records per page.
   * @returns {Promise<Array>} A promise that resolves to an array of cell records.
   */
  async getAvailableEndNodes(page = 1, pageSize = 10) {
    const offset = (page - 1) * pageSize;
    const query = `
      SELECT *
      FROM cells
      WHERE 
        is_block = 0 
        AND is_has_box = 0
        AND cell_type = 'storage'
      ORDER BY 
        floor_id ASC, 
        \`row\` ASC, 
        col ASC
      LIMIT ?
      OFFSET ?;
    `;

    try {
      const [rows] = await pool.query(query, [pageSize, offset]);
      return rows;
    } catch (error) {
      logger.error('[CellRepository] Error fetching available end nodes:', error);
      throw error;
    }
  }

  /**
   * Updates the 'is_has_box' status for a given cell.
   * This is called when a shuttle successfully drops a box into the cell.
   * 
   * @param {number} cellId - The ID of the cell to update.
   * @param {boolean} hasBox - The new status (true for 1, false for 0).
   * @returns {Promise<boolean>} True on success.
   */
  async updateCellHasBox(cellId, hasBox) {
    const statusValue = hasBox ? 1 : 0;
    const query = 'UPDATE cells SET is_has_box = ? WHERE id = ?;';

    try {
      const [result] = await pool.query(query, [statusValue, cellId]);
      logger.info(`[CellRepository] Updated is_has_box to ${statusValue} for cell ID: ${cellId}`);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error(`[CellRepository] Error updating is_has_box for cell ID ${cellId}:`, error);
      throw error;
    }
  }

  async updateCellBlockStatus(cellId, isBlock) {
    const statusValue = isBlock ? 1 : 0;
    const query = 'UPDATE cells SET is_block = ? WHERE id = ?;';
    try {
      const [result] = await pool.query(query, [statusValue, cellId]);
      logger.info(`[CellRepository] Updated is_block to ${statusValue} for cell ID: ${cellId}`);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error(`[CellRepository] Error updating is_block for cell ID ${cellId}:`, error);
      throw error;
    }
  }

  async getCellByName(cellName, floorId) {
    const query = 'SELECT * FROM cells WHERE name = ? AND floor_id = ?;';
    try {
        const [rows] = await pool.query(query, [cellName, floorId]);
        return rows[0] || null;
    } catch (error) {
        logger.error(`[CellRepository] Error fetching cell by name ${cellName}:`, error);
        throw error;
    }
  }

  async getCellByNameAnyFloor(name) {
    const query = 'SELECT * FROM cells WHERE name = ?;';
    try {
      const [rows] = await pool.query(query, [name]);
      return rows;
    } catch (error) {
      logger.error('[CellRepository] Error fetching cell by name (any floor):', error);
      throw error;
    }
  }

  async getCellByQrCode(qrCode, floorId) {
    const query = 'SELECT * FROM cells WHERE qr_code = ? AND floor_id = ?;';
    try {
        const [rows] = await pool.query(query, [qrCode, floorId]);
        return rows[0] || null;
    } catch (error) {
        logger.error(`[CellRepository] Error fetching cell by QR code ${qrCode}:`, error);
        throw error;
    }
  }

  async getCellByQrCodeAnyFloor(qrCode) {
    const query = 'SELECT * FROM cells WHERE qr_code = ?;';
    try {
      const [rows] = await pool.query(query, [qrCode]);
      return rows;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching cell by QR code (any floor) for QR ${qrCode}:`, error);
      throw error;
    }
  }

  async getAllCellsByFloor(floorId) {
    const query = 'SELECT * FROM cells WHERE floor_id = ? ORDER BY `row`, col;';
    try {
      const [rows] = await pool.query(query, [floorId]);
      return rows;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching all cells by floor ${floorId}:`, error);
      throw error;
    }
  }

  async getCellForPathfinding(name, floorId) {
    // This appears to be functionally identical to getCellByName
    return this.getCellByName(name, floorId);
  }

  async getCellByPosition(col, row, floorId) {
    const query = 'SELECT * FROM cells WHERE col = ? AND `row` = ? AND floor_id = ?;';
    try {
      const [rows] = await pool.query(query, [col, row, floorId]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching cell by position (${col},${row}) on floor ${floorId}:`, error);
      throw error;
    }
  }

  async getFloorByRackAndFloorName(rackName, floorName) {
    const query = `
        SELECT f.*
        FROM rack_floors f
        JOIN racks r ON f.rack_id = r.id
        WHERE r.name = ? AND f.name = ?;
    `;
    try {
        const [rows] = await pool.query(query, [rackName, floorName]);
        return rows[0] || null;
    } catch (error) {
        logger.error(`[CellRepository] Error fetching floor by rack '${rackName}' and floor '${floorName}':`, error);
        throw error;
    }
  }
}

module.exports = new CellRepository();