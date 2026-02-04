const AMRTaskQueueService = require('../queue/AMRTaskQueueService');
const AMRStateManager = require('../state/AMRStateManager');
const PathReservationService = require('../reservation/PathReservationService');
const ConflictDetectionService = require('../conflict/ConflictDetectionService');
const TrafficCoordinatorService = require('../traffic/TrafficCoordinatorService');
const PathfinderWithReservations = require('../pathfinding/PathfinderWithReservations');
const DispatchStrategy = require('./DispatchStrategy');
const AMRLogger = require('../utils/AMRLogger');
const config = require('../config/amr.dispatcher.config');

class AMRDispatcherService {
    constructor(graph) {
        this.graph = graph;
        this.pathfinder = new PathfinderWithReservations(graph);
        this.dispatchTimer = null;
        this.retryMap = new Map();
    }

    async dispatchNextTask() {
        try {
            const task = await AMRTaskQueueService.getNextTask();
            if (!task) return;

            const idleAMRs = await AMRStateManager.getIdleAMRs();
            if (idleAMRs.length === 0) {
                AMRLogger.dispatcher('No idle AMRs available');
                return;
            }

            const optimalAMR = await DispatchStrategy.selectOptimalAMR(
                idleAMRs,
                task,
                this.graph
            );

            if (!optimalAMR) {
                AMRLogger.dispatcher('No suitable AMR found', { taskId: task.taskId });
                return;
            }

            const canAssign = await this.canAssignTask(optimalAMR, task);

            if (canAssign.success) {
                await this.assignTask(optimalAMR, task, canAssign.path);
            } else {
                await this.handleAssignmentFailure(task, canAssign.reason);
            }
        } catch (error) {
            AMRLogger.error('Dispatcher', 'Dispatch failed', error);
        }
    }

    async canAssignTask(amr, task) {
        try {
            const path = await this.pathfinder.findPath(
                amr.currentNode,
                task.pickupNode,
                amr.amrId
            );

            if (!path) {
                return { success: false, reason: 'No path available' };
            }

            const isAvailable = await PathReservationService.isPathAvailable(
                path,
                amr.amrId
            );

            if (!isAvailable) {
                return { success: false, reason: 'Path blocked', path };
            }

            return { success: true, path };
        } catch (error) {
            AMRLogger.error('Dispatcher', 'Failed to check assignment', error);
            return { success: false, reason: error.message };
        }
    }

    async assignTask(amr, task, path) {
        try {
            const reservation = await PathReservationService.reservePath(
                amr.amrId,
                path,
                task.taskId
            );

            if (!reservation.success) {
                throw new Error('Failed to reserve path');
            }

            await AMRStateManager.setCurrentTask(amr.amrId, task.taskId);
            await AMRStateManager.setReservedPath(amr.amrId, path);
            await AMRTaskQueueService.updateTaskStatus(task.taskId, 'ASSIGNED', amr.amrId);

            this.retryMap.delete(task.taskId);

            AMRLogger.dispatcher('Task assigned', {
                taskId: task.taskId,
                amrId: amr.amrId,
                pathLength: path.length
            });

            return true;
        } catch (error) {
            AMRLogger.error('Dispatcher', 'Failed to assign task', error);
            return false;
        }
    }

    async handleAssignmentFailure(task, reason) {
        const retryCount = this.retryMap.get(task.taskId) || 0;
        const shouldRetry = await DispatchStrategy.shouldRetryAssignment(task, retryCount);

        if (shouldRetry) {
            this.retryMap.set(task.taskId, retryCount + 1);

            AMRLogger.dispatcher('Assignment failed, will retry', {
                taskId: task.taskId,
                reason,
                retryCount: retryCount + 1
            });
        } else {
            await AMRTaskQueueService.cancelTask(task.taskId, `Max retries exceeded: ${reason}`);
            this.retryMap.delete(task.taskId);

            AMRLogger.dispatcher('Task cancelled after max retries', {
                taskId: task.taskId,
                reason
            });
        }
    }

    start() {
        if (this.dispatchTimer) {
            AMRLogger.dispatcher('Already running');
            return;
        }

        this.dispatchTimer = setInterval(
            () => this.dispatchNextTask(),
            config.dispatcher.interval
        );

        AMRLogger.dispatcher('Dispatcher started', {
            interval: config.dispatcher.interval
        });
    }

    stop() {
        if (this.dispatchTimer) {
            clearInterval(this.dispatchTimer);
            this.dispatchTimer = null;
            AMRLogger.dispatcher('Dispatcher stopped');
        }
    }
}

module.exports = AMRDispatcherService;
