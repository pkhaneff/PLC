const { logger } = require('../../logger/logger');
const redisClient = require('../../redis/init.redis');
const cellService = require('./cellService');

/**
 * Service quản lý phối hợp hàng (row) giữa các shuttle khi có nhiều shuttle hoạt động.
 * 
 * Khi có ≥2 shuttle:
 * - Shuttle đầu tiên trong batch quyết định hàng (dựa trên endNode)
 * - Các shuttle tiếp theo phải dùng cùng hàng đó
 * - Tất cả shuttle đi cùng hướng (LEFT_TO_RIGHT cho IN operation)
 */
class RowCoordinationService {
    constructor() {
        this.ROW_ASSIGNMENT_PREFIX = 'row_coordination:batch';
        this.DEFAULT_TTL = 3600; // 1 hour
    }

    /**
     * Lấy key Redis cho row assignment của batch
     * @param {string} batchId - ID của batch
     * @returns {string} Redis key
     */
    getRowAssignmentKey(batchId) {
        return `${this.ROW_ASSIGNMENT_PREFIX}:${batchId}`;
    }

    /**
     * Gán hàng cho một batch. Nếu batch đã có hàng được gán, trả về hàng đó.
     * Nếu chưa, xác định hàng dựa trên endNode và lưu vào Redis.
     * 
     * @param {string} batchId - ID của batch
     * @param {string} endNodeQr - QR code của endNode
     * @param {number} floorId - ID của floor
     * @returns {Promise<number|null>} Row number hoặc null nếu không tìm thấy
     */
    async assignRowForBatch(batchId, endNodeQr, floorId) {
        try {
            const key = this.getRowAssignmentKey(batchId);

            // Kiểm tra xem batch đã có row assignment chưa
            const existingRow = await redisClient.get(key);
            if (existingRow !== null) {
                const rowNum = parseInt(existingRow, 10);
                logger.info(`[RowCoordination] Batch ${batchId} đã có row ${rowNum} được gán`);
                return rowNum;
            }

            // Chưa có row assignment, xác định row từ endNode
            const endNodeCell = await cellService.getCellByQrCode(endNodeQr, floorId);
            if (!endNodeCell) {
                logger.error(`[RowCoordination] Không tìm thấy endNode ${endNodeQr} trên floor ${floorId}`);
                return null;
            }

            const assignedRow = endNodeCell.row;

            // Lưu row assignment vào Redis với TTL
            await redisClient.set(key, assignedRow.toString(), { EX: this.DEFAULT_TTL });

            const endNodeName = await cellService.getCachedDisplayName(endNodeQr, floorId);
            logger.info(`[RowCoordination] ✅ Gán row ${assignedRow} cho batch ${batchId} (dựa trên endNode ${endNodeName})`);

            return assignedRow;

        } catch (error) {
            logger.error(`[RowCoordination] Lỗi khi gán row cho batch ${batchId}:`, error);
            return null;
        }
    }

    /**
     * Lấy hàng đã được gán cho batch
     * @param {string} batchId - ID của batch
     * @returns {Promise<number|null>} Row number hoặc null nếu chưa gán
     */
    async getAssignedRow(batchId) {
        try {
            const key = this.getRowAssignmentKey(batchId);
            const row = await redisClient.get(key);

            if (row !== null) {
                return parseInt(row, 10);
            }

            return null;
        } catch (error) {
            logger.error(`[RowCoordination] Lỗi khi lấy assigned row cho batch ${batchId}:`, error);
            return null;
        }
    }

    /**
     * Giải phóng row assignment khi batch hoàn thành
     * @param {string} batchId - ID của batch
     * @returns {Promise<boolean>} Success
     */
    async releaseRowAssignment(batchId) {
        try {
            const key = this.getRowAssignmentKey(batchId);
            const row = await this.getAssignedRow(batchId);

            await redisClient.del(key);

            if (row !== null) {
                logger.info(`[RowCoordination] Giải phóng row ${row} cho batch ${batchId}`);
            }

            return true;
        } catch (error) {
            logger.error(`[RowCoordination] Lỗi khi giải phóng row assignment cho batch ${batchId}:`, error);
            return false;
        }
    }

    /**
     * Kiểm tra xem một node có nằm trong hàng đã gán không
     * @param {string} nodeQr - QR code của node
     * @param {number} floorId - ID của floor
     * @param {number} assignedRow - Row đã được gán
     * @returns {Promise<boolean>} True nếu node nằm trong assigned row
     */
    async isNodeInAssignedRow(nodeQr, floorId, assignedRow) {
        try {
            const cell = await cellService.getCellByQrCode(nodeQr, floorId);
            if (!cell) {
                return false;
            }

            return cell.row === assignedRow;
        } catch (error) {
            logger.error(`[RowCoordination] Lỗi khi kiểm tra node ${nodeQr} trong row ${assignedRow}:`, error);
            return false;
        }
    }

    /**
     * Tìm node gần nhất trong assigned row (dùng khi endNode không nằm trong assigned row)
     * @param {string} currentQr - QR code hiện tại
     * @param {number} assignedRow - Row đã được gán
     * @param {number} floorId - ID của floor
     * @returns {Promise<string|null>} QR code của node gần nhất trong assigned row
     */
    async findNearestNodeInRow(currentQr, assignedRow, floorId) {
        try {
            const currentCell = await cellService.getCellByQrCode(currentQr, floorId);
            if (!currentCell) {
                logger.error(`[RowCoordination] Không tìm thấy current node ${currentQr}`);
                return null;
            }

            // Lấy tất cả cells trong assigned row
            const CellRepository = require('../../repository/cell.repository');
            const rowCells = await CellRepository.getCellsByRow(assignedRow, floorId);

            if (!rowCells || rowCells.length === 0) {
                logger.error(`[RowCoordination] Không tìm thấy cells nào trong row ${assignedRow}`);
                return null;
            }

            // Tìm cell gần nhất (Manhattan distance)
            let minDistance = Infinity;
            let nearestCell = null;

            for (const cell of rowCells) {
                if (cell.is_block === 1) continue; // Bỏ qua blocked cells

                const distance = Math.abs(cell.col - currentCell.col) + Math.abs(cell.row - currentCell.row);
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestCell = cell;
                }
            }

            if (nearestCell) {
                const nearestName = await cellService.getCachedDisplayName(nearestCell.qr_code, floorId);
                logger.info(`[RowCoordination] Tìm thấy node gần nhất trong row ${assignedRow}: ${nearestName} (distance: ${minDistance})`);
                return nearestCell.qr_code;
            }

            return null;

        } catch (error) {
            logger.error(`[RowCoordination] Lỗi khi tìm nearest node trong row ${assignedRow}:`, error);
            return null;
        }
    }
}

module.exports = new RowCoordinationService();
