const apiConfig = require('../../config/api.config');

class CargoEndpoint {
    constructor(httpClient, baseIP) {
        this.httpClient = httpClient;
        this.baseIP = baseIP;
        this.config = apiConfig.endpoints.cargo;
    }

    async fetch() {
        const url = `http://${this.baseIP}:${this.config.port}${this.config.path}`;
        const data = await this.httpClient.get(url, this.config.timeout);

        return {
            loaded: data.has_cargo,
            weight: data.weight,
            items: data.items || [],
            timestamp: Date.now()
        };
    }
}

module.exports = CargoEndpoint;
