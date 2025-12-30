const plcManager = require('../modules/PLC/plcManager');

class HealthController {
    constructor() {
        this.isInitialized = false;
    }

    setInitialized(value) {
        this.isInitialized = value;
    }

    checkHealth(req, res) {
        const isReady = this.isInitialized;
        const plcIds = isReady ? plcManager.getAllPLCIds() : [];

        res.json({
            status: isReady ? 'healthy' : 'initializing',
            service: 'PLC Server',
            plcs: {
                ready: isReady,
                count: plcIds.length,
                ids: plcIds
            },
            timestamp: new Date().toISOString(),
            uptime: process.uptime() 
        });
    }
}

module.exports = new HealthController();
