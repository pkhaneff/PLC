class TaskController {
    constructor(amrApiClient) {
        this.amrId = amrApiClient.amrId;
        this.apiClient = amrApiClient;
    }

    async assignTask(task) {
        console.log(`[TaskController] ${this.amrId} assigned task:`, task);
        return await this.apiClient.goToTarget(task.target);
    }

    async pauseTask() {
        console.log(`[TaskController] ${this.amrId} pausing task`);
        return await this.apiClient.pauseTask();
    }

    async resumeTask() {
        console.log(`[TaskController] ${this.amrId} resuming task`);
        return await this.apiClient.resumeTask();
    }

    async cancelTask() {
        console.log(`[TaskController] ${this.amrId} canceling task`);
        return await this.apiClient.cancelTask();
    }
}

module.exports = TaskController;
