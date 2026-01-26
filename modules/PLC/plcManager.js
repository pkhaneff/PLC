const InitPlc = require('./init.plc');
const workerManager = require('../../worker/workerManager');
const plcStateManager = require('./PLCStateManager');
const { logger } = require('../../logger/logger');

class PLCManager {
  constructor() {
    this.plcReaders = {};
    this.isInitialized = false;
  }

  async initializePLC(plcId, config, tags, options) {
    plcStateManager.initializePLCState(plcId, { is_active: true });

    const reader = new InitPlc(config, tags, options);

    // Add error listener to prevent app crash on unhandled error events
    reader.on('error', (err) => {
      logger.error(`[PLCManager] Error from PLC '${plcId}':`, err || 'Unknown PLC error');
    });

    await reader.start();

    this.plcReaders[plcId] = reader;

    return reader;
  }

  async initializeMultiplePLCs(plcsConfig = []) {
    logger.debug(`[PLCManager] Initializing ${plcsConfig.length} PLCs...`);

    const initPromises = plcsConfig.map((config) => {
      const { plcConfig, variables, options } = config;
      return this.initializePLC(plcConfig.id, plcConfig, variables, options);
    });

    await Promise.all(initPromises);

    this.isInitialized = true;
  }

  getPLCReader(plcId) {
    const reader = this.plcReaders[plcId];
    if (!reader) {
      logger.warn(`[PLCManager] PLC '${plcId}' not found`);
    }
    return reader || null;
  }

  getValue(plcId, varName) {
    const reader = this.plcReaders[plcId];
    if (!reader) {
      logger.warn(`[PLCManager] PLC '${plcId}' not found`);
      return undefined;
    }
    return reader.getValue(varName);
  }

  async writeValue(plcId, varName, value) {
    const reader = this.plcReaders[plcId];
    if (!reader) {
      logger.warn(`[PLCManager] PLC '${plcId}' not found`);
      return { error: 'PLC not found' };
    }
    return await reader.writeItems(varName, value);
  }

  getAllValues(plcId) {
    const reader = this.plcReaders[plcId];
    if (!reader) {
      logger.warn(`[PLCManager] PLC '${plcId}' not found`);
      return {};
    }
    return reader.getAllValues();
  }

  getConnectionStats(plcId) {
    const reader = this.plcReaders[plcId];
    if (!reader) return null;
    return reader.getStatus();
  }

  getAllPLCIds() {
    return Object.keys(this.plcReaders);
  }

  getValuesByPrefix(plcId, prefix) {
    const reader = this.plcReaders[plcId];
    if (!reader) return {};

    const result = {};
    const allValues = reader.getAllValues();

    for (const key in allValues) {
      if (key.startsWith(prefix)) {
        result[key] = allValues[key];
      }
    }
    return result;
  }

  async shutdownAll() {
    const shutdownPromises = Object.entries(this.plcReaders).map(([plcId, reader]) => {
      return reader.shutdown();
    });

    await Promise.all(shutdownPromises);
  }

  isPlcConnected(plcId) {
    const reader = this.plcReaders[plcId];
    if (!reader) return false;
    return reader.isConnected;
  }

  getActivePLC() {
    const plcIds = this.getAllPLCIds();
    const workersInfo = workerManager.getWorkersInfo();

    for (const plcId of plcIds) {
      const isActive = plcStateManager.getIsActive(plcId);
      const isConnected = this.isPlcConnected(plcId);

      if (isActive && isConnected) {
        const workerInfo = workersInfo.find((w) => w.plcId === plcId);

        if (!workerInfo || !workerInfo.isProcessing) {
          logger.debug(`[PLCManager] Found idle PLC: ${plcId}`);
          return plcId;
        }
      }
    }

    let bestPlcId = null;
    let minQueueLength = Infinity;

    for (const plcId of plcIds) {
      const isActive = plcStateManager.getIsActive(plcId);
      const isConnected = this.isPlcConnected(plcId);

      if (isActive && isConnected) {
        const workerInfo = workersInfo.find((w) => w.plcId === plcId);
        const queueLength = workerInfo ? workerInfo.queuedTasks : 0;

        if (queueLength < minQueueLength) {
          minQueueLength = queueLength;
          bestPlcId = plcId;
        }
      }
    }

    if (bestPlcId) {
      const workerInfo = workersInfo.find((w) => w.plcId === bestPlcId);
      logger.warn(
        `[PLCManager] All PLCs busy, selected ${bestPlcId} with queue length: ${workerInfo?.queuedTasks || 0}`
      );
    } else {
      logger.warn(`[PLCManager] No available PLC found (all inactive or disconnected)`);
    }

    return bestPlcId;
  }

  setPlcActive(plcId, isActive) {
    const reader = this.plcReaders[plcId];
    if (reader) {
      plcStateManager.setIsActive(plcId, isActive);
      return true;
    }
    return false;
  }
}

module.exports = new PLCManager();
