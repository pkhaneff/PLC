const { logger } = require('../logger/logger');

/**
 * Repository for all database interactions with the 'cells' table.
 * Refactored to use Dependency Injection - tuân thủ Dependency Inversion Principle
 */
class CellRepository {
  /**
   * @param {Object} dbConnection - Database connection instance (injected)
   */
  constructor(dbConnection) {
    this.db = dbConnection;
  }

  /**
   * Updates the 'is_has_box' status for a given cell.
   *
   * @param {number} cellId - The ID of the cell to update.
   * @param {boolean} hasBox - The new status (true for 1, false for 0).
   * @param {string} palletId - (Optional) The ID of the pallet/item (only updated if hasBox is true).
   * @returns {Promise<boolean>} True on success.
   */
  async updateCellHasBox(cellId, hasBox, palletId = null) {
    const statusValue = hasBox ? 1 : 0;

    let query;
    const params = [statusValue];

    if (hasBox && palletId !== undefined) {
      query = 'UPDATE cells SET is_has_box = ?, pallet_id = ? WHERE id = ?;';
      params.push(palletId);
    } else if (!hasBox) {
      query = 'UPDATE cells SET is_has_box = ?, pallet_id = NULL WHERE id = ?;';
    } else {
      query = 'UPDATE cells SET is_has_box = ? WHERE id = ?;';
    }

    params.push(cellId);

    try {
      const [result] = await this.db.query(query, params);
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
      const [result] = await this.db.query(query, [statusValue, cellId]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error(`[CellRepository] Error updating is_block for cell ID ${cellId}:`, error);
      throw error;
    }
  }

  async getCellByName(cellName, floorId) {
    const query = 'SELECT * FROM cells WHERE name = ? AND floor_id = ?;';
    try {
      const [rows] = await this.db.query(query, [cellName, floorId]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching cell by name ${cellName}:`, error);
      throw error;
    }
  }

  async getCellByNameAnyFloor(name) {
    const query = 'SELECT * FROM cells WHERE name = ?;';
    try {
      const [rows] = await this.db.query(query, [name]);
      return rows;
    } catch (error) {
      logger.error('[CellRepository] Error fetching cell by name (any floor):', error);
      throw error;
    }
  }

  async getCellByQrCode(qrCode, floorId) {
    const query = 'SELECT * FROM cells WHERE qr_code = ? AND floor_id = ?;';
    try {
      const [rows] = await this.db.query(query, [qrCode, floorId]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching cell by QR code ${qrCode}:`, error);
      throw error;
    }
  }

  async getCellByQrCodeAnyFloor(qrCode) {
    const query = 'SELECT * FROM cells WHERE qr_code = ?;';
    try {
      const [rows] = await this.db.query(query, [qrCode]);
      return rows;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching cell by QR code (any floor) for QR ${qrCode}:`, error);
      throw error;
    }
  }

  async getAllCellsByFloor(floorId) {
    const query = 'SELECT * FROM cells WHERE floor_id = ? ORDER BY `row`, col;';
    try {
      const [rows] = await this.db.query(query, [floorId]);
      return rows;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching all cells by floor ${floorId}:`, error);
      throw error;
    }
  }

  async getCellByPosition(col, row, floorId) {
    const query = 'SELECT * FROM cells WHERE col = ? AND `row` = ? AND floor_id = ?;';
    try {
      const [rows] = await this.db.query(query, [col, row, floorId]);
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
      const [rows] = await this.db.query(query, [rackName, floorName]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching floor by rack '${rackName}' and floor '${floorName}':`, error);
      throw error;
    }
  }

  async getFloorById(floorId) {
    const query = `
      SELECT f.*, r.name as rack_name, r.id as rack_id
      FROM rack_floors f
      JOIN racks r ON f.rack_id = r.id
      WHERE f.id = ?
    `;
    try {
      const [rows] = await this.db.query(query, [floorId]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching floor by ID ${floorId}:`, error);
      throw error;
    }
  }

  async getCellByCoordinate(col, row, floorId) {
    const query = `
      SELECT * FROM cells 
      WHERE \`col\` = ? AND \`row\` = ? AND floor_id = ?
      LIMIT 1;
    `;
    const [rows] = await this.db.query(query, [col, row, floorId]);
    return rows[0];
  }

  async validateRackFloor(rackId, floorId) {
    const query = `
      SELECT id FROM rack_floors
      WHERE id = ? AND rack_id = ?
    `;
    try {
      const [rows] = await this.db.query(query, [floorId, rackId]);
      return rows.length > 0;
    } catch (error) {
      logger.error(`[CellRepository] Error validating rack ${rackId} and floor ${floorId}:`, error);
      throw error;
    }
  }

  async getCellWithNames(qrCode, floorId) {
    const query = `
      SELECT c.*, f.name as floor_name, r.name as rack_name
      FROM cells c
      JOIN rack_floors f ON c.floor_id = f.id
      JOIN racks r ON f.rack_id = r.id
      WHERE c.qr_code = ? AND c.floor_id = ?
    `;
    try {
      const [rows] = await this.db.query(query, [qrCode, floorId]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching cell with names for QR ${qrCode}:`, error);
      throw error;
    }
  }

  /**
   * Get deep cell info (including floor_id and rack_id) by unique QR code.
   */
  async getCellDeepInfoByQr(qrCode) {
    const query = `
      SELECT c.*, f.rack_id, r.name as rack_name, f.name as floor_name
      FROM cells c
      JOIN rack_floors f ON c.floor_id = f.id
      JOIN racks r ON f.rack_id = r.id
      WHERE c.qr_code = ?
      LIMIT 1;
    `;
    try {
      const [rows] = await this.db.query(query, [qrCode]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`[CellRepository] Error fetching deep cell info for QR ${qrCode}:`, error);
      throw error;
    }
  }

  /**
   * Tìm row đầu tiên (theo FIFO) có node khả dụng, trả về TẤT CẢ node khả dụng trong row đó
   * FIFO order: floor ASC, row ASC, col ASC
   * @param {string} palletType - Loại pallet
   * @param {number} floorId - Floor ID
   * @returns {Promise<Array>} Danh sách tất cả node khả dụng trong row đầu tiên
   */
  async findAvailableNodesByFIFO(palletType, floorId = null) {
    let query = `
            SELECT c.*
            FROM cells c
            WHERE c.pallet_classification = ?
              AND c.is_has_box = 0
              AND c.is_block = 0
              AND c.cell_type = 'storage'
        `;

    const params = [palletType];

    if (floorId) {
      query += ` AND c.floor_id = ? `;
      params.push(floorId);
    }

    query += `
            ORDER BY
              c.floor_id ASC,
              c.\`row\` ASC,
              c.col ASC
        `;

    try {
      const [allNodes] = await this.db.query(query, params);

      if (!allNodes || allNodes.length === 0) {
        return [];
      }

      const firstRow = allNodes[0].row;

      const nodesInFirstRow = allNodes.filter((n) => n.row === firstRow);

      `[CellRepository] Found ${nodesInFirstRow.length} available nodes in row ${firstRow} (floor ${floorId}, pallet ${palletType})`;
      return nodesInFirstRow;
    } catch (error) {
      logger.error('[CellRepository] Error finding available nodes by FIFO:', error);
      throw error;
    }
  }

  async getAvailableNodesInRow(floorId, row, palletType) {
    const query = `
            SELECT c.*
            FROM cells c
            WHERE c.pallet_classification = ?
              AND c.floor_id = ?
              AND c.\`row\` = ?
              AND c.is_has_box = 0
              AND c.is_block = 0
              AND c.cell_type = 'storage'
            ORDER BY c.col ASC
        `;

    try {
      const [rows] = await this.db.query(query, [palletType, floorId, row]);
      return rows;
    } catch (error) {
      logger.error(`[CellRepository] Error getting available nodes in row ${row}:`, error);
      throw error;
    }
  }

  /**
   * Tìm row đầu tiên (theo FIFO) có node chứa hàng, trả về TẤT CẢ node có hàng trong row đó
   * FIFO order cho OUTBOUND: floor ASC, row ASC, col ASC
   * @param {string} palletType - Loại pallet
   * @param {number} rackId - Rack ID (optional)
   * @param {number} floorId - Floor ID (optional)
   * @returns {Promise<Array>} Danh sách tất cả node có hàng trong row đầu tiên
   */
  async findOccupiedNodesByFIFO(palletType, rackId = null, floorId = null) {
    let query = `
            SELECT c.*
            FROM cells c
            JOIN rack_floors f ON c.floor_id = f.id
            WHERE c.pallet_classification = ?
              AND c.is_has_box = 1
              AND c.is_block = 0
              AND c.cell_type = 'storage'
        `;

    const params = [palletType];

    if (rackId) {
      query += ` AND f.rack_id = ? `;
      params.push(rackId);
    }

    if (floorId) {
      query += ` AND c.floor_id = ? `;
      params.push(floorId);
    }

    query += `
            ORDER BY
              c.floor_id ASC,
              c.\`row\` ASC,
              c.col ASC
        `;

    try {
      const [allNodes] = await this.db.query(query, params);

      if (!allNodes || allNodes.length === 0) {
        return [];
      }

      const firstRow = allNodes[0].row;
      const firstFloor = allNodes[0].floor_id;

      const nodesInFirstRow = allNodes.filter((n) => n.row === firstRow && n.floor_id === firstFloor);

      logger.info(
        `[CellRepository] Found ${nodesInFirstRow.length} occupied nodes in row ${firstRow} (floor ${firstFloor}, pallet ${palletType})`
      );
      return nodesInFirstRow;
    } catch (error) {
      logger.error('[CellRepository] Error finding occupied nodes by FIFO:', error);
      throw error;
    }
  }

  /**
   * Lấy tất cả cells trong một row cụ thể
   * @param {number} row - Row number
   * @param {number} floorId - Floor ID
   * @returns {Promise<Array>} Danh sách tất cả cells trong row
   */
  async getCellsByRow(row, floorId) {
    const query = `
            SELECT c.*
            FROM cells c
            WHERE c.floor_id = ?
              AND c.\`row\` = ?
            ORDER BY c.col ASC
        `;

    try {
      const [rows] = await this.db.query(query, [floorId, row]);
      return rows;
    } catch (error) {
      logger.error(`[CellRepository] Error getting cells in row ${row}:`, error);
      throw error;
    }
  }

  /**
   * Update node status (item_ID)
   * @param {string} qrCode - QR code của node
   * @param {object} data - Data cần update (ví dụ: { item_ID: "ITEM001" })
   * @returns {Promise<boolean>}
   */
  async updateNodeStatus(qrCode, data) {
    const query = `
            UPDATE cells
            SET pallet_id = ?
            WHERE qr_code = ?
        `;

    try {
      const [result] = await this.db.query(query, [data.item_ID || null, qrCode]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error(`[CellRepository] Error updating node status for ${qrCode}:`, error);
      throw error;
    }
  }

  /**
   * Check if a pallet ID already exists in any cell.
   * @param {string} palletId - The pallet ID to check.
   * @param {string} palletType - The classification/type of the pallet.
   * @returns {Promise<boolean>}
   */
  async isPalletIdExists(palletId, palletType) {
    const query = `
            SELECT id FROM cells
            WHERE pallet_id = ? AND pallet_classification = ?
            LIMIT 1;
        `;
    try {
      const [rows] = await this.db.query(query, [palletId, palletType]);
      return rows.length > 0;
    } catch (error) {
      logger.error(`[CellRepository] Error checking if pallet ID ${palletId} exists:`, error);
      throw error;
    }
  }
}

module.exports = CellRepository;
