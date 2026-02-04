class MotionController {
    constructor(amrApiClient) {
        this.amrId = amrApiClient.amrId;
        this.apiClient = amrApiClient;
    }

    async moveToTarget(target) {
        console.log(`[MotionController] ${this.amrId} moving to target:`, target);
        return await this.apiClient.goToTarget(target);
    }

    async moveToTargetList(targets) {
        console.log(`[MotionController] ${this.amrId} moving to target list:`, targets);
        return await this.apiClient.goToTargetList(targets);
    }

    async stopMovement() {
        console.log(`[MotionController] ${this.amrId} stopping`);
        return await this.apiClient.stop();
    }

    async relocate(position) {
        console.log(`[MotionController] ${this.amrId} relocating to:`, position);
        return await this.apiClient.relocate(position);
    }

    async translate(params) {
        console.log(`[MotionController] ${this.amrId} translating:`, params);
        return await this.apiClient.translate(params);
    }

    async turn(params) {
        console.log(`[MotionController] ${this.amrId} turning:`, params);
        return await this.apiClient.turn(params);
    }

    async circular(params) {
        console.log(`[MotionController] ${this.amrId} circular movement:`, params);
        return await this.apiClient.circular(params);
    }
}

module.exports = MotionController;
