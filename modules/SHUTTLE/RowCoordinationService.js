const { logger } = require('../../logger/logger');
const redisClient = require('../../redis/init.redis');
const cellService = require('./cellService');

class RowCoordinationService {
    constructor() {
        this.ROW_ASSIGNMENT_PREFIX = 'row_coordination:batch';
        this.DEFAULT_TTL = 3600; // 1 hour
    }

    getRowAssignmentKey(batchId) {
        return `${this.ROW_ASSIGNMENT_PREFIX}:${batchId}`;
    }

    async assignRowForBatch(batchId, endNodeQr, floorId) {
        try {
            const key = this.getRowAssignmentKey(batchId);

            const existingRow = await redisClient.get(key);
            if (existingRow !== null) {
                const rowNum = parseInt(existingRow, 10);
                return rowNum;
            }

            const endNodeCell = await cellService.getCellByQrCode(endNodeQr, floorId);
            if (!endNodeCell) {
                logger.error(`[RowCoordination] Không tìm thấy endNode ${endNodeQr} trên floor ${floorId}`);
                return null;
            }

            const assignedRow = endNodeCell.row;

            await redisClient.set(key, assignedRow.toString(), { EX: this.DEFAULT_TTL });

            const endNodeName = await cellService.getCachedDisplayName(endNodeQr, floorId);

            return assignedRow;

        } catch (error) {
            logger.error(`[RowCoordination] Lỗi khi gán row cho batch ${batchId}:`, error);
            return null;
        }
    }

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

    async releaseRowAssignment(batchId) {
        try {
            const key = this.getRowAssignmentKey(batchId);

            await redisClient.del(key);

            return true;
        } catch (error) {
            logger.error(`[RowCoordination] Lỗi khi giải phóng row assignment cho batch ${batchId}:`, error);
            return false;
        }
    }

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

    async findNearestNodeInRow(currentQr, assignedRow, floorId) {
        try {
            const currentCell = await cellService.getCellByQrCode(currentQr, floorId);
            if (!currentCell) {
                logger.error(`[RowCoordination] Không tìm thấy current node ${currentQr}`);
                return null;
            }

            const CellRepository = require('../../repository/cell.repository');
            const rowCells = await CellRepository.getCellsByRow(assignedRow, floorId);

            if (!rowCells || rowCells.length === 0) {
                logger.error(`[RowCoordination] Không tìm thấy cells nào trong row ${assignedRow}`);
                return null;
            }

            let minDistance = Infinity;
            let nearestCell = null;

            for (const cell of rowCells) {
                if (cell.is_block === 1) continue;

                const distance = Math.abs(cell.col - currentCell.col) + Math.abs(cell.row - currentCell.row);
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestCell = cell;
                }
            }

            if (nearestCell) {
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
