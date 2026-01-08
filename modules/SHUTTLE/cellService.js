const CellRepository = require('../../repository/cell.repository');
const { logger } = require('../../logger/logger');

/**
 * Service layer for cell-related business logic.
 * Decouples controllers and other services from the database repository.
 * All data access is delegated to the CellRepository.
 */
class CellService {

  // --- Read methods delegated to Repository ---

  async getCellByName(name, floorId) {
    return CellRepository.getCellByName(name, floorId);
  }

  async getCellByNameAnyFloor(name) {
    return CellRepository.getCellByNameAnyFloor(name);
  }

  async getCellByQrCode(qrCode, floorId) {
    return CellRepository.getCellByQrCode(qrCode, floorId);
  }

  async getCellByQrCodeAnyFloor(qrCode) {
    return CellRepository.getCellByQrCodeAnyFloor(qrCode);
  }
  
  async getFloorByRackAndFloorName(rackName, floorName) {
    return CellRepository.getFloorByRackAndFloorName(rackName, floorName);
  }

  async getAllCellsByFloor(floorId) {
    return CellRepository.getAllCellsByFloor(floorId);
  }

  async getCellForPathfinding(name, floorId) {
    return CellRepository.getCellForPathfinding(name, floorId);
  }

  async getCellByPosition(col, row, floorId) {
    return CellRepository.getCellByPosition(col, row, floorId);
  }

  // --- Write methods delegated to Repository ---

  async updateCellHasBox(cellId, hasBox) {
    return CellRepository.updateCellHasBox(cellId, hasBox);
  }

  async updateCellBlockStatus(cellId, isBlock) {
    return CellRepository.updateCellBlockStatus(cellId, isBlock);
  }

  // --- Obsolete Methods ---
  // The following methods are intentionally removed as their logic is replaced
  // by the new Scheduler Worker and distributed lock mechanism:
  // - findAndReserveNextEmptyCellFIFO
  // - findNextEmptyCellFIFO
  // - unreserveCell
  // - verifyCellsExist (can be implemented in repo if needed elsewhere)
  // - getFloorIdByLogicalNumber (can be implemented in repo if needed elsewhere)
  // - getFloorByRackAndOrder (can be implemented in repo if needed elsewhere)
  // - getFloorsByRackName (can be implemented in repo if needed elsewhere)
}

module.exports = new CellService();
