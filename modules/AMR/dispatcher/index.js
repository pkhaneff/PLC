const AMRDispatcherManager = require('./dispatcher/AMRDispatcherManager');
const AMRTaskQueueService = require('./queue/AMRTaskQueueService');
const AMRStateManager = require('./state/AMRStateManager');
const PathReservationService = require('./reservation/PathReservationService');
const TrafficCoordinatorService = require('./traffic/TrafficCoordinatorService');
const DeadlockDetector = require('./conflict/DeadlockDetector');

module.exports = {
    dispatcherManager: AMRDispatcherManager,
    taskQueue: AMRTaskQueueService,
    stateManager: AMRStateManager,
    reservation: PathReservationService,
    traffic: TrafficCoordinatorService,
    deadlock: DeadlockDetector,

    async initialize() {
        return await AMRDispatcherManager.initialize();
    },

    async start() {
        return await AMRDispatcherManager.start();
    },

    stop() {
        AMRDispatcherManager.stop();
    },

    async addTask(task) {
        return await AMRTaskQueueService.addTask(task);
    },

    async updateAMRState(amrId, state) {
        return await AMRStateManager.updateState(amrId, state);
    },

    async getAMRState(amrId) {
        return await AMRStateManager.getState(amrId);
    },

    async releaseAMRPath(amrId) {
        return await PathReservationService.releasePath(amrId);
    },

    async checkDeadlock() {
        return await DeadlockDetector.detectDeadlock();
    }
};
