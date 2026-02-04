const apiConfig = require('../../config/api.config');

class StatusEndpoint {
    constructor(httpClient, baseIP) {
        this.httpClient = httpClient;
        this.baseIP = baseIP;
        this.config = apiConfig.endpoints.status;
    }

    async fetch() {
        const url = `http://${this.baseIP}:${this.config.port}${this.config.path}`;
        const data = await this.httpClient.get(url, this.config.timeout);

        return {
            status: data.status,
            error: data.error_code || null,
            mode: data.mode,
            timestamp: Date.now()
        };
    }
}

module.exports = StatusEndpoint;
