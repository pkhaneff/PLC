const DataPoller = require('./DataPoller');
const pollingConfig = require('../config/polling.config');

class AMRPoller {
    constructor(amrClient, storage) {
        this.amrId = amrClient.amrId;
        this.client = amrClient;
        this.storage = storage;
        this.pollers = {};
    }

    start() {
        this.startLocationPolling();
        this.startBatteryPolling();
        this.startCargoPolling();
        this.startStatusPolling();
        this.startSensorsPolling();
    }

    stop() {
        Object.values(this.pollers).forEach(poller => poller.stop());
        this.pollers = {};
    }

    startLocationPolling() {
        this.pollers.location = new DataPoller(
            `${this.amrId}-location`,
            () => this.client.getLocation(),
            (data) => this.storage.save(`amr:${this.amrId}:location`, data),
            pollingConfig.intervals.location
        );
        this.pollers.location.start();
    }

    startBatteryPolling() {
        this.pollers.battery = new DataPoller(
            `${this.amrId}-battery`,
            () => this.client.getBattery(),
            (data) => this.storage.save(`amr:${this.amrId}:battery`, data),
            pollingConfig.intervals.battery
        );
        this.pollers.battery.start();
    }

    startCargoPolling() {
        this.pollers.cargo = new DataPoller(
            `${this.amrId}-cargo`,
            () => this.client.getCargo(),
            (data) => this.storage.save(`amr:${this.amrId}:cargo`, data),
            pollingConfig.intervals.cargo
        );
        this.pollers.cargo.start();
    }

    startStatusPolling() {
        this.pollers.status = new DataPoller(
            `${this.amrId}-status`,
            () => this.client.getStatus(),
            (data) => this.storage.save(`amr:${this.amrId}:status`, data),
            pollingConfig.intervals.status
        );
        this.pollers.status.start();
    }

    startSensorsPolling() {
        this.pollers.sensors = new DataPoller(
            `${this.amrId}-sensors`,
            () => this.client.getSensors(),
            (data) => this.storage.save(`amr:${this.amrId}:sensors`, data),
            pollingConfig.intervals.sensors
        );
        this.pollers.sensors.start();
    }

    async getCurrentData() {
        const keys = ['location', 'battery', 'cargo', 'status', 'sensors'];
        const data = {};

        for (const key of keys) {
            data[key] = await this.storage.get(`amr:${this.amrId}:${key}`);
        }

        return { amr_id: this.amrId, ...data };
    }
}

module.exports = AMRPoller;
