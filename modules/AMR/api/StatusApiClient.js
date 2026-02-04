const HttpClient = require('./HttpClient');
const { API_ENDPOINTS } = require('../config/api.endpoints');

class StatusApiClient {
    constructor() {
        this.httpClient = new HttpClient();
        this.port = API_ENDPOINTS.STATUS.PORT;
    }

    async getLocation(amrIp) {
        const response = await this.httpClient.sendRequest(
            amrIp,
            this.port,
            API_ENDPOINTS.STATUS.LOCATION
        );

        return this._parseLocationResponse(response);
    }

    _parseLocationResponse(response) {
        if (response.status !== 'success') {
            throw new Error(`Failed to get location: ${response.message || 'Unknown error'}`);
        }

        return response.data;
    }
}

module.exports = StatusApiClient;
