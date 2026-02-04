const HttpClient = require('./HttpClient');
const { API_ENDPOINTS } = require('../config/api.endpoints');

class ControlApiClient {
    constructor() {
        this.httpClient = new HttpClient();
        this.port = API_ENDPOINTS.CONTROL.PORT;
    }

    async stop(amrIp) {
        return await this._sendControlCommand(
            amrIp,
            API_ENDPOINTS.CONTROL.STOP
        );
    }

    async relocate(amrIp, position) {
        return await this._sendControlCommand(
            amrIp,
            API_ENDPOINTS.CONTROL.RELOCATE,
            position
        );
    }

    async motion(amrIp, motionParams) {
        return await this._sendControlCommand(
            amrIp,
            API_ENDPOINTS.CONTROL.MOTION,
            motionParams
        );
    }

    async _sendControlCommand(amrIp, requestCode, payload = {}) {
        const response = await this.httpClient.sendRequest(
            amrIp,
            this.port,
            requestCode,
            payload
        );

        if (response.status !== 'success') {
            throw new Error(`Control command failed: ${response.message || 'Unknown error'}`);
        }

        return response.data;
    }
}

module.exports = ControlApiClient;
