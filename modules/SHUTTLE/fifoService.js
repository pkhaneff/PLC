const pool = require('../../config/database');

class FIFOService {
  async findCellUsingFIFO(rackId, hasBox = false) {
    try {
      const floorQuery = `
        SELECT id, floor_order
        FROM rack_floor
        WHERE rack_id = ?
        ORDER BY floor_order ASC
      `;

      const [floors] = await pool.execute(floorQuery, [rackId]);

      if (!floors || floors.length === 0) {
        return null;
      }

      for (const floor of floors) {
        const cellQuery = `
          SELECT *
          FROM cells
          WHERE floor_id = ?
            AND cell_type = 'storage'
            AND is_block = 0
            AND is_has_box = ?
          ORDER BY
            col ASC,
            \`row\` ASC
          LIMIT 1
        `;

        const [cells] = await pool.execute(cellQuery, [floor.id, hasBox ? 1 : 0]);

        if (cells && cells.length > 0) {
          return cells[0];
        }
      }

      return null;
    } catch (error) {
      console.error('Error in findCellUsingFIFO:', error);
      throw error;
    }
  }
}

module.exports = new FIFOService();
