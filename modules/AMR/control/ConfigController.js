class ConfigController {
    constructor(amrApiClient) {
        this.amrId = amrApiClient.amrId;
        this.apiClient = amrApiClient;
    }

    async updateMap(mapData) {
        console.log(`[ConfigController] ${this.amrId} updating map`);
        return await this.apiClient.uploadAndSwitchMap(mapData);
    }

    async lockConfiguration() {
        console.log(`[ConfigController] ${this.amrId} locking configuration`);
        return await this.apiClient.lockConfig();
    }

    async downloadMap() {
        console.log(`[ConfigController] ${this.amrId} downloading map`);
        return await this.apiClient.downloadMap();
    }
}

module.exports = ConfigController;
