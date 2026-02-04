const StatusApiClient = require('./StatusApiClient');
const ControlApiClient = require('./ControlApiClient');
const NavigationApiClient = require('./NavigationApiClient');
const ConfigApiClient = require('./ConfigApiClient');

class AMRApiClient {
    constructor(amrId, amrIp) {
        this.amrId = amrId;
        this.amrIp = amrIp;

        this.status = new StatusApiClient();
        this.control = new ControlApiClient();
        this.navigation = new NavigationApiClient();
        this.config = new ConfigApiClient();
    }

    async getLocation() {
        return await this.status.getLocation(this.amrIp);
    }

    async stop() {
        return await this.control.stop(this.amrIp);
    }

    async relocate(position) {
        return await this.control.relocate(this.amrIp, position);
    }

    async motion(motionParams) {
        return await this.control.motion(this.amrIp, motionParams);
    }

    async pauseTask() {
        return await this.navigation.pauseTask(this.amrIp);
    }

    async resumeTask() {
        return await this.navigation.resumeTask(this.amrIp);
    }

    async cancelTask() {
        return await this.navigation.cancelTask(this.amrIp);
    }

    async goToTarget(target) {
        return await this.navigation.goToTarget(this.amrIp, target);
    }

    async goToTargetList(targets) {
        return await this.navigation.goToTargetList(this.amrIp, targets);
    }

    async translate(params) {
        return await this.navigation.translate(this.amrIp, params);
    }

    async turn(params) {
        return await this.navigation.turn(this.amrIp, params);
    }

    async circular(params) {
        return await this.navigation.circular(this.amrIp, params);
    }

    async lockConfig() {
        return await this.config.lockConfig(this.amrIp);
    }

    async downloadMap() {
        return await this.config.downloadMap(this.amrIp);
    }

    async uploadAndSwitchMap(mapData) {
        return await this.config.uploadAndSwitchMap(this.amrIp, mapData);
    }
}

module.exports = AMRApiClient;
