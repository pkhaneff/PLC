const mapLoaderService = require('./services/mapLoader.service');
const AMRDispatcherService = require('./dispatcher/AMRDispatcherService');
const ReservationCleaner = require('./reservation/ReservationCleaner');
const AMRLogger = require('./utils/AMRLogger');

class AMRDispatcherManager {
    constructor() {
        this.dispatcher = null;
        this.graph = null;
        this.initialized = false;
    }

    async initialize() {
        try {
            if (this.initialized) {
                AMRLogger.debug('Manager', 'Already initialized');
                return true;
            }

            AMRLogger.dispatcher('Initializing AMR Dispatcher System');

            this.graph = await mapLoaderService.loadMap();

            if (!this.graph) {
                throw new Error('Failed to load map');
            }

            this.dispatcher = new AMRDispatcherService(this.graph);

            ReservationCleaner.start();

            this.initialized = true;

            AMRLogger.dispatcher('AMR Dispatcher System initialized', {
                nodeCount: this.graph.getNodeCount()
            });

            return true;
        } catch (error) {
            AMRLogger.error('Manager', 'Initialization failed', error);
            return false;
        }
    }

    async start() {
        if (!this.initialized) {
            const success = await this.initialize();
            if (!success) {
                throw new Error('Failed to initialize dispatcher');
            }
        }

        this.dispatcher.start();
        AMRLogger.dispatcher('Dispatcher started');
    }

    stop() {
        if (this.dispatcher) {
            this.dispatcher.stop();
        }

        ReservationCleaner.stop();

        AMRLogger.dispatcher('Dispatcher stopped');
    }

    getDispatcher() {
        return this.dispatcher;
    }

    isInitialized() {
        return this.initialized;
    }
}

module.exports = new AMRDispatcherManager();
