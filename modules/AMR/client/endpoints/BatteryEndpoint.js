const apiConfig = require('../../config/api.config');

class BatteryEndpoint {
    constructor(httpClient, baseIP) {
        this.httpClient = httpClient;
        this.baseIP = baseIP;
        this.config = apiConfig.endpoints.battery;
    }

    async fetch() {
        const url = `http://${this.baseIP}:${this.config.port}${this.config.path}`;
        const data = await this.httpClient.get(url, this.config.timeout);

        return {
            level: data.battery_level,
            voltage: data.voltage,
            charging: data.is_charging,
            timestamp: Date.now()
        };
    }
}

module.exports = BatteryEndpoint;
