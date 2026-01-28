const plcManager = require('../modules/PLC/plcManager');

class HealthController {
  constructor() {
    this._isInitialized = false;
  }

  setInitialized(value) {
    this._isInitialized = value;
  }

  checkHealth(req, res) {
    const isReady = this._isInitialized;
    const plcIds = isReady ? plcManager.getAllPLCIds() : [];

    res.json({
      status: isReady ? 'healthy' : 'initializing',
      service: 'PLC Server',
      plcs: {
        ready: isReady,
        count: plcIds.length,
        ids: plcIds,
      },
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  }
}

module.exports = new HealthController();
