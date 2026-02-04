const apiConfig = require('../../config/api.config');

class SensorsEndpoint {
    constructor(httpClient, baseIP) {
        this.httpClient = httpClient;
        this.baseIP = baseIP;
        this.config = apiConfig.endpoints.sensors;
    }

    async fetch() {
        const url = `http://${this.baseIP}:${this.config.port}${this.config.path}`;
        const data = await this.httpClient.get(url, this.config.timeout);

        return {
            obstacles: data.obstacles || [],
            distance: data.front_distance,
            timestamp: Date.now()
        };
    }
}

module.exports = SensorsEndpoint;
