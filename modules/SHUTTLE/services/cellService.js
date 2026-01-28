const { cellRepository: CellRepository } = require('../../../core/bootstrap');
const { logger } = require('../../../config/logger');

/**
 * Service layer for cell-related business logic.
 * Decouples controllers and other services from the database repository.
 * All data access is delegated to the CellRepository.
 * Refactored to use DI - CellRepository is now injected via bootstrap
 */
class CellService {
  constructor() {
    // Cache for cell name lookups: "qrCode:floorId" -> name
    this.nameCache = new Map();
  }

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

  // --- New ID-based methods for QR code system ---

  /**
   * Get floor by ID (instead of by name)
   * @param {number} floorId - Floor ID
   * @returns {Promise<object|null>} Floor info with rack name
   */
  async getFloorById(floorId) {
    return CellRepository.getFloorById(floorId);
  }

  /**
   * Validate rack and floor relationship
   * @param {number} rackId - Rack ID
   * @param {number} floorId - Floor ID
   * @returns {Promise<boolean>} True if valid relationship
   */
  async validateRackFloor(rackId, floorId) {
    return CellRepository.validateRackFloor(rackId, floorId);
  }

  /**
   * Get cell with names for logging
   * @param {string} qrCode - QR code
   * @param {number} floorId - Floor ID
   * @returns {Promise<object|null>} Cell with rack and floor names
   */
  async getCellWithNames(qrCode, floorId) {
    return CellRepository.getCellWithNames(qrCode, floorId);
  }

  /**
   * Enrich log with human-readable names
   * @param {string} qrCode - QR code
   * @param {number} floorId - Floor ID
   * @returns {Promise<string>} Formatted string for logging
   */
  async enrichLogWithNames(qrCode, floorId) {
    const cell = await this.getCellWithNames(qrCode, floorId);
    if (!cell) return `QR:${qrCode}`;
    return `${cell.name} (QR:${qrCode}, Rack:${cell.rack_name}, Floor:${cell.floor_name})`;
  }

  /**
   * Get display name for logging (name only, without QR code)
   * @param {string} qrCode - QR code of the cell
   * @param {number} floorId - Floor ID
   * @returns {Promise<string>} Cell name or qrCode as fallback
   */
  async getDisplayName(qrCode, floorId) {
    try {
      const cell = await this.getCellWithNames(qrCode, floorId);
      if (!cell || !cell.name) {
        return qrCode; // Fallback to qrCode
      }
      return cell.name; // Return only the name
    } catch (error) {
      logger.error(`[CellService] Error getting display name for ${qrCode}:`, error.message);
      return qrCode; // Fallback on error
    }
  }

  /**
   * Get cached display name for logging (optimized with cache)
   * @param {string} qrCode - QR code of the cell
   * @param {number} floorId - Floor ID
   * @returns {Promise<string>} Cell name or qrCode as fallback
   */
  async getCachedDisplayName(qrCode, floorId) {
    const cacheKey = `${qrCode}:${floorId}`;

    // Check cache
    if (this.nameCache.has(cacheKey)) {
      return this.nameCache.get(cacheKey);
    }

    // Fetch from DB
    const displayName = await this.getDisplayName(qrCode, floorId);

    // Store in cache
    this.nameCache.set(cacheKey, displayName);

    return displayName;
  }

  /**
   * Get display name without floorId (when floorId is not available)
   * Slower than getCachedDisplayName but works without floorId
   * @param {string} qrCode - QR code of the cell
   * @returns {Promise<string>} Cell name or qrCode as fallback
   */
  async getDisplayNameWithoutFloor(qrCode) {
    try {
      // Try cache first (any floor)
      for (const [key, value] of this.nameCache.entries()) {
        if (key.startsWith(`${qrCode}:`)) {
          return value;
        }
      }

      // Query DB - returns array of cells
      const cells = await CellRepository.getCellByQrCodeAnyFloor(qrCode);
      if (!cells || cells.length === 0 || !cells[0].name) {
        return qrCode;
      }

      const cell = cells[0]; // Take first match

      // Cache it with floor_id
      if (cell.floor_id) {
        const cacheKey = `${qrCode}:${cell.floor_id}`;
        this.nameCache.set(cacheKey, cell.name);
      }

      return cell.name;
    } catch (error) {
      logger.error(`[CellService] Error getting display name without floor for ${qrCode}:`, error.message);
      return qrCode;
    }
  }

  clearNameCache() {
    this.nameCache.clear();
  }

  async updateCellHasBox(cellId, hasBox, palletId) {
    return CellRepository.updateCellHasBox(cellId, hasBox, palletId);
  }

  async updateCellBlockStatus(cellId, isBlock) {
    return CellRepository.updateCellBlockStatus(cellId, isBlock);
  }

  async getCellByCoordinate(col, row, floorId) {
    try {
      return await CellRepository.getCellByCoordinate(col, row, floorId);
    } catch (error) {
      logger.error(`Error in getCellByCoordinate: ${error.message}`);
      throw error;
    }
  }

  async getCellDeepInfoByQr(qrCode) {
    return CellRepository.getCellDeepInfoByQr(qrCode);
  }
}

module.exports = new CellService();
