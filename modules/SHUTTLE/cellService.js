const pool = require('../../config/database');

class NodeService {

  async getCellByName(name, floorId) {
    try {
      const query = `
        SELECT
          id,
          name,
          cell_type,
          qr_code,
          is_has_box,
          is_block,
          floor_id
        FROM cells
        WHERE name = ? AND floor_id = ?
        LIMIT 1
      `;

      const [rows] = await pool.execute(query, [name, floorId]);
      return rows[0] || null;
    } catch (error) {
      console.error('Error fetching cell by name and floor:', error);
      throw error;
    }
  }

  async getCellByNameAnyFloor(name) {
    try {
      const query = `
        SELECT
          id,
          name,
          cell_type,
          qr_code,
          is_has_box,
          is_block,
          floor_id
        FROM cells
        WHERE name = ?
      `;

      const [rows] = await pool.execute(query, [name]);
      return rows;
    } catch (error) {
      console.error('Error fetching cell by name (any floor):', error);
      throw error;
    }
  }

  async getCellByQrCode(qrCode, floorId) {
    try {
      const query = `
        SELECT
          id,
          name,
          cell_type,
          qr_code,
          col,
          \`row\`,
          is_has_box,
          is_block,
          floor_id
        FROM cells
        WHERE qr_code = ? AND floor_id = ?
        LIMIT 1
      `;

      const [rows] = await pool.execute(query, [qrCode, floorId]);
      const result = rows[0] || null;
      console.log(`[cellService] getCellByQrCode(${qrCode}, ${floorId}) result: ${result ? `Found on floor ${result.floor_id}` : 'Not found'}`); // DEBUG LOG
      return result;
    } catch (error) {
      console.error('Error fetching cell by QR code and floor:', error);
      throw error;
    }
  }

  async verifyCellsExist(cellNames, floorId) {
    try {
      const placeholders = cellNames.map(() => '?').join(',');
      const query = `
        SELECT name
        FROM cells
        WHERE name IN (${placeholders}) AND floor_id = ?
      `;

      const [rows] = await pool.execute(query, [...cellNames, floorId]);
      return rows.length === cellNames.length;
    } catch (error) {
      console.error('Error verifying cells exist:', error);
      throw error;
    }
  }

  async updateCellBoxStatus(cellId, hasBox) {
    try {
      const query = `
        UPDATE cells
        SET is_has_box = ?
        WHERE id = ?
      `;

      await pool.execute(query, [hasBox, cellId]);
      return true;
    } catch (error) {
      console.error('Error updating cell box status:', error);
      throw error;
    }
  }

  /**
   * Tìm cell trống tiếp theo dựa trên thứ tự FIFO (tầng thấp nhất, cột thấp nhất, hàng thấp nhất)
   * @returns {Object|null} Cell object hoặc null nếu không tìm thấy cell trống nào
   */
  async findNextEmptyCellFIFO() {
    try {
      const query = `
        SELECT
          c.id, c.name, c.col, c.\`row\`, c.direction_type, c.is_block, c.floor_id, c.cell_type, c.qr_code, c.is_has_box
        FROM cells c
        JOIN rack_floors rf ON c.floor_id = rf.id
        WHERE c.is_has_box = 0 AND (c.is_block = 0 OR c.is_block IS NULL) AND c.cell_type = 'storage'
        ORDER BY rf.floor_order ASC, c.col ASC, c.\`row\` ASC
        LIMIT 1
      `;
      const [rows] = await pool.execute(query);
      return rows[0] || null;
    } catch (error) {
      console.error('Error finding next empty cell FIFO:', error);
      throw error;
    }
  }

  /**
   * Lấy tất cả cells theo floor_id để sử dụng cho pathfinding
   * @param {number} floorId - ID của tầng
   * @returns {Array} Mảng cells với các trường: id, name, col, row, direction_type, is_block, floor_id
   */
  async getAllCellsByFloor(floorId) {
    try {
      const query = `
        SELECT
          id,
          name,
          col,
          \`row\`,
          direction_type,
          is_block,
          floor_id,
          cell_type,
          qr_code,
          is_has_box
        FROM cells
        WHERE floor_id = ?
        ORDER BY \`row\`, col
      `;

      const [rows] = await pool.execute(query, [floorId]);
      return rows;
    } catch (error) {
      console.error('Error fetching all cells by floor:', error);
      throw error;
    }
  }

  async getCellForPathfinding(name, floorId) {
    try {
      const query = `
        SELECT
          id,
          name,
          col,
          \`row\`,
          direction_type,
          is_block,
          floor_id,
          cell_type,
          qr_code
        FROM cells
        WHERE name = ? AND floor_id = ?
        LIMIT 1
      `;

      const [rows] = await pool.execute(query, [name, floorId]);
      return rows[0] || null;
    } catch (error) {
      console.error('Error fetching cell for pathfinding:', error);
      throw error;
    }
  }

  /**
   * Lấy cell tại vị trí (col, row) trên floor_id
   * @param {number} col - Cột
   * @param {number} row - Hàng
   * @param {number} floorId - ID của tầng
   * @returns {Object|null} Cell object hoặc null nếu không tìm thấy
   */
  async getCellByPosition(col, row, floorId) {
    try {
      const query = `
        SELECT
          id,
          name,
          col,
          \`row\`,
          direction_type,
          is_block,
          floor_id,
          cell_type,
          qr_code
        FROM cells
        WHERE col = ? AND \`row\` = ? AND floor_id = ?
        LIMIT 1
      `;

      const [rows] = await pool.execute(query, [col, row, floorId]);
      return rows[0] || null;
    } catch (error) {
      console.error('Error fetching cell by position:', error);
      throw error;
    }
  }

  /**
   * Lấy ID tầng trong CSDL dựa trên số tầng logic (ví dụ: tầng 1 -> ID 138)
   * @param {number} logicalNumber - Số tầng logic
   * @returns {number|null} ID tầng trong CSDL hoặc null nếu không tìm thấy
   */
  async getFloorIdByLogicalNumber(logicalNumber) {
    try {
      const query = `
        SELECT id
        FROM rack_floors
        WHERE id = ?
        LIMIT 1
      `;
      const [rows] = await pool.execute(query, [logicalNumber]);
      return rows[0] ? rows[0].id : null;
    } catch (error) {
      console.error('Error fetching floor ID by logical number:', error);
      throw error;
    }
  }
}

module.exports = new NodeService();
