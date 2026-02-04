const HttpClient = require('./HttpClient');
const { API_ENDPOINTS } = require('../config/api.endpoints');

class NavigationApiClient {
    constructor() {
        this.httpClient = new HttpClient();
        this.port = API_ENDPOINTS.NAVIGATION.PORT;
    }

    async pauseTask(amrIp) {
        return await this._sendNavigationCommand(amrIp, API_ENDPOINTS.NAVIGATION.PAUSE);
    }

    async resumeTask(amrIp) {
        return await this._sendNavigationCommand(amrIp, API_ENDPOINTS.NAVIGATION.RESUME);
    }

    async cancelTask(amrIp) {
        return await this._sendNavigationCommand(amrIp, API_ENDPOINTS.NAVIGATION.CANCEL);
    }

    async goToTarget(amrIp, target) {
        return await this._sendNavigationCommand(
            amrIp,
            API_ENDPOINTS.NAVIGATION.GO_TO_TARGET,
            target
        );
    }

    async goToTargetList(amrIp, targets) {
        return await this._sendNavigationCommand(
            amrIp,
            API_ENDPOINTS.NAVIGATION.GO_TO_TARGET_LIST,
            { targets }
        );
    }

    async translate(amrIp, params) {
        return await this._sendNavigationCommand(
            amrIp,
            API_ENDPOINTS.NAVIGATION.TRANSLATE,
            params
        );
    }

    async turn(amrIp, params) {
        return await this._sendNavigationCommand(
            amrIp,
            API_ENDPOINTS.NAVIGATION.TURN,
            params
        );
    }

    async circular(amrIp, params) {
        return await this._sendNavigationCommand(
            amrIp,
            API_ENDPOINTS.NAVIGATION.CIRCULAR,
            params
        );
    }

    async _sendNavigationCommand(amrIp, requestCode, payload = {}) {
        const response = await this.httpClient.sendRequest(
            amrIp,
            this.port,
            requestCode,
            payload
        );

        if (response.status !== 'success') {
            throw new Error(`Navigation command failed: ${response.message || 'Unknown error'}`);
        }

        return response.data;
    }
}

module.exports = NavigationApiClient;
