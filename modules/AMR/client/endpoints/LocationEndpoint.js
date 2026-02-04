const apiConfig = require('../../config/api.config');

class LocationEndpoint {
    constructor(httpClient, baseIP) {
        this.httpClient = httpClient;
        this.baseIP = baseIP;
        this.config = apiConfig.endpoints.location;
    }

    async fetch() {
        const url = `http://${this.baseIP}:${this.config.port}${this.config.path}`;
        const data = await this.httpClient.get(url, this.config.timeout);

        return {
            x: data.x,
            y: data.y,
            node: data.current_node,
            timestamp: Date.now()
        };
    }
}

module.exports = LocationEndpoint;
