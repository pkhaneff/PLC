const HttpClient = require('./HttpClient');
const { API_ENDPOINTS } = require('../config/api.endpoints');

class ConfigApiClient {
    constructor() {
        this.httpClient = new HttpClient();
        this.port = API_ENDPOINTS.CONFIGURATION.PORT;
    }

    async lockConfig(amrIp) {
        return await this._sendConfigCommand(
            amrIp,
            API_ENDPOINTS.CONFIGURATION.LOCK
        );
    }

    async downloadMap(amrIp) {
        return await this._sendConfigCommand(
            amrIp,
            API_ENDPOINTS.CONFIGURATION.DOWNLOAD_MAP
        );
    }

    async uploadAndSwitchMap(amrIp, mapData) {
        return await this._sendConfigCommand(
            amrIp,
            API_ENDPOINTS.CONFIGURATION.UPLOAD_SWITCH_MAP,
            { mapData }
        );
    }

    async _sendConfigCommand(amrIp, requestCode, payload = {}) {
        const response = await this.httpClient.sendRequest(
            amrIp,
            this.port,
            requestCode,
            payload
        );

        if (response.status !== 'success') {
            throw new Error(`Config command failed: ${response.message || 'Unknown error'}`);
        }

        return response.data;
    }
}

module.exports = ConfigApiClient;
