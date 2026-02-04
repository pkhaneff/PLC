const AMRManager = require('./AMRManager');
const amrConfig = require('./config/amr.config');

const manager = new AMRManager();

function setEventHandler(eventHandler) {
    if (eventHandler) {
        manager.setEventHandler(eventHandler);
    }
}

function initializePolling() {
    manager.initialize(amrConfig.amrs);
    manager.startPolling();
}

function shutdownPolling() {
    manager.stopPolling();
}

module.exports = {
    setEventHandler,
    initializePolling,
    shutdownPolling,
    manager,
};
