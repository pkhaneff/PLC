const AMRApiClient = require('./api/AMRApiClient');
const StatusPoller = require('./polling/StatusPoller');
const PollerManager = require('./polling/PollerManager');
const RedisStorage = require('./storage/RedisStorage');
const MotionController = require('./control/MotionController');
const TaskController = require('./control/TaskController');
const ConfigController = require('./control/ConfigController');
const amrService = require('./services/amr.service');

class AMRManager {
    constructor() {
        this.amrs = new Map();
        this.pollerManager = new PollerManager();
        this.storage = new RedisStorage();
        this.eventHandler = null;
    }

    setEventHandler(eventHandler) {
        this.eventHandler = eventHandler;
        console.log('[AMRManager] Event handler set');
    }

    initialize(amrConfigs) {
        console.log(`[AMRManager] Initializing ${amrConfigs.length} AMRs`);

        amrConfigs.forEach((config) => {
            this.addAMR(config);
        });

        console.log(`[AMRManager] Initialized ${this.amrs.size} AMRs`);
    }

    addAMR(config) {
        const { id, ip } = config;

        if (this.amrs.has(id)) {
            console.warn(`[AMRManager] AMR ${id} already exists`);
            return;
        }

        const apiClient = new AMRApiClient(id, ip);
        const statusPoller = new StatusPoller(apiClient, this.storage);
        const motionController = new MotionController(apiClient);
        const taskController = new TaskController(apiClient);
        const configController = new ConfigController(apiClient);

        this.amrs.set(id, {
            id,
            ip,
            apiClient,
            motion: motionController,
            task: taskController,
            config: configController,
        });

        this.pollerManager.addPoller(id, statusPoller);

        console.log(`[AMRManager] Added AMR ${id} (${ip})`);
    }

    removeAMR(amrId) {
        this.pollerManager.removePoller(amrId);
        this.amrs.delete(amrId);
        console.log(`[AMRManager] Removed AMR ${amrId}`);
    }

    startPolling() {
        this.pollerManager.startAll();
        console.log('[AMRManager] Polling started');
    }

    stopPolling() {
        this.pollerManager.stopAll();
        console.log('[AMRManager] Polling stopped');
    }

    async getAMRData(amrId) {
        const poller = this.pollerManager.getPoller(amrId);
        return poller ? await poller.getCurrentData() : null;
    }

    async getAllAMRData() {
        const data = {};
        for (const [amrId] of this.amrs) {
            data[amrId] = await this.getAMRData(amrId);
        }
        return data;
    }

    getAMR(amrId) {
        return this.amrs.get(amrId);
    }

    getAllAMRs() {
        return Array.from(this.amrs.values());
    }

    async controlAMR(amrId, action, params = {}) {
        const amr = this.getAMR(amrId);
        if (!amr) {
            throw new Error(`AMR ${amrId} not found`);
        }

        const { motion, task, config } = amr;

        switch (action) {
            case 'move':
                return await motion.moveToTarget(params.target);
            case 'stop':
                return await motion.stopMovement();
            case 'pause':
                return await task.pauseTask();
            case 'resume':
                return await task.resumeTask();
            case 'cancel':
                return await task.cancelTask();
            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    async executeTask(amrId, taskRequest) {
        const { start, end, action } = taskRequest;

        console.log(`[AMRManager] Executing task for ${amrId}: ${start} → ${end} (${action})`);

        const pathResult = amrService.generatePath(start, end, action);
        const { move_task_list } = pathResult;

        console.log(`[AMRManager] Generated path with ${move_task_list.length} tasks`);

        const amr = this.getAMR(amrId);
        if (!amr) {
            throw new Error(`AMR ${amrId} not found`);
        }

        await amr.apiClient.goToTargetList(move_task_list);

        return {
            success: true,
            data: {
                move_task_list,
                amr_id: amrId,
                start,
                end,
                action,
            },
        };
    }

    /**
     * Execute task asynchronously (fire-and-forget pattern like SHUTTLE)
     * Validates, queues task, and executes in background with socket events
     * @param {object} taskData - Task data with start, end, action, taskId, move_task_list
     */
    async executeTaskAsync(taskData) {
        const { taskId, amrId, start, end, action, move_task_list } = taskData;

        try {
            console.log(`[AMRManager] Executing task async: ${taskId} for AMR ${amrId}`);

            if (this.eventHandler) {
                this.eventHandler.emitQueued({
                    taskId,
                    amrId,
                    start,
                    end,
                    action,
                    totalSteps: move_task_list.length,
                });
            }

            const amr = this.getAMR(amrId);
            if (!amr) {
                throw new Error(`AMR ${amrId} not found`);
            }

            if (this.eventHandler) {
                this.eventHandler.emitAssigned({
                    taskId,
                    amrId,
                    pathLength: move_task_list.length,
                });
            }

            await amr.apiClient.goToTargetList(move_task_list);

            if (this.eventHandler) {
                this.eventHandler.emitStarted({
                    taskId,
                    amrId,
                    totalSteps: move_task_list.length,
                });
            }

            for (let i = 0; i < move_task_list.length; i++) {
                const step = move_task_list[i];

                await new Promise(resolve => setTimeout(resolve, 3000));

                if (this.eventHandler) {
                    this.eventHandler.emitProgress({
                        taskId,
                        amrId,
                        currentStep: i + 1,
                        totalSteps: move_task_list.length,
                        currentNode: step.id,
                        sourceNode: step.source_id,
                        operation: step.operation || null,
                    });
                }
            }

            if (this.eventHandler) {
                this.eventHandler.emitCompleted({
                    taskId,
                    amrId,
                    totalSteps: move_task_list.length,
                });
            }

            console.log(`[AMRManager] Task ${taskId} completed successfully`);
        } catch (error) {
            console.error(`[AMRManager] Task ${taskId} failed:`, error.message);

            if (this.eventHandler) {
                this.eventHandler.emitFailed({
                    taskId,
                    amrId,
                    error: error.message,
                });
            }
        }
    }
}

module.exports = AMRManager;
