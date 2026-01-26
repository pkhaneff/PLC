const fs = require('fs');
const path = require('path');
const { logger } = require('../../logger/logger');

class PLCStateManager {
  constructor() {
    this.stateFilePath = path.join(__dirname, 'plcState.json');
    this.state = this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, 'utf8');
        return JSON.parse(data);
      }
      return {};
    } catch (error) {
      logger.error('[PLCStateManager] Error loading state:', error);
      return {};
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (error) {
      logger.error('[PLCStateManager] Error saving state:', error);
    }
  }

  initializePLCState(plcId, initialState = { is_active: true }) {
    if (!this.state[plcId]) {
      this.state[plcId] = initialState;
      this.saveState();
    }
  }

  getIsActive(plcId) {
    if (!this.state[plcId]) {
      return false;
    }
    return this.state[plcId].is_active ?? true;
  }

  setIsActive(plcId, isActive) {
    if (!this.state[plcId]) {
      this.state[plcId] = {};
    }
    this.state[plcId].is_active = isActive;
    this.saveState();
  }

  getAllStates() {
    return this.state;
  }
}

module.exports = new PLCStateManager();
