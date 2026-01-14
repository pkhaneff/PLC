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
     * @param {string} palletType - (Optional) The pallet classification to filter by.
     * @param {number} floorId - (Optional) The floor ID to filter by.
     * @returns {Promise<Array>} A promise that resolves to an array of cell records.
     */
    async getAvailableEndNodes(page = 1, pageSize = 10, palletType = null, floorId = null) {
        const offset = (page - 1) * pageSize;
        let query = `
      SELECT *
      FROM cells
      WHERE 
        is_block = 0 
        AND is_has_box = 0
        AND cell_type = 'storage'
    `;

        const params = [];

        if (palletType) {
            query += ` AND pallet_classification = ? `;
            params.push(palletType);
        }

        if (floorId) {
            query += ` AND floor_id = ? `;
            params.push(floorId);
        }

        query += `
      ORDER BY 
        floor_id ASC, 
        \`row\` ASC, 
        col ASC
      LIMIT ?
      OFFSET ?;
    `;

        params.push(pageSize, offset);

        try {
            const [rows] = await pool.query(query, params);
            return rows;
        } catch (error) {
            logger.error('[CellRepository] Error fetching available end nodes:', error);
            throw error;
        }
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
            const [result] = await pool.query(query, params);
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

    async getFloorById(floorId) {
        const query = `
      SELECT f.*, r.name as rack_name, r.id as rack_id
      FROM rack_floors f
      JOIN racks r ON f.rack_id = r.id
      WHERE f.id = ?
    `;
        try {
            const [rows] = await pool.query(query, [floorId]);
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
        const [rows] = await pool.query(query, [col, row, floorId]);
        return rows[0];
    }

    async validateRackFloor(rackId, floorId) {
        const query = `
      SELECT id FROM rack_floors
      WHERE id = ? AND rack_id = ?
    `;
        try {
            const [rows] = await pool.query(query, [floorId, rackId]);
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
            const [rows] = await pool.query(query, [qrCode, floorId]);
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
            const [rows] = await pool.query(query, [qrCode]);
            return rows[0] || null;
        } catch (error) {
            logger.error(`[CellRepository] Error fetching deep cell info for QR ${qrCode}:`, error);
            throw error;
        }
    }
}

module.exports = new CellRepository();
