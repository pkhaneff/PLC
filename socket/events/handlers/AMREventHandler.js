const eventEmitter = require('../EventEmitter');
const { AMR_EVENTS } = require('../EventTypes');
const { logger } = require('../../../config/logger');

class AMREventHandler {
    emitQueued(taskData) {
        const { taskId, amrId, start, end, action, totalSteps } = taskData;

        return eventEmitter.emit(AMR_EVENTS.TASK_QUEUED, {
            taskId,
            amrId,
            status: 'queued',
            start,
            end,
            action,
            totalSteps,
        });
    }

    emitAssigned(taskData) {
        const { taskId, amrId, pathLength } = taskData;

        return eventEmitter.emit(AMR_EVENTS.TASK_ASSIGNED, {
            taskId,
            amrId,
            status: 'assigned',
            pathLength,
        });
    }

    emitStarted(taskData) {
        const { taskId, amrId, totalSteps } = taskData;

        return eventEmitter.emit(AMR_EVENTS.TASK_STARTED, {
            taskId,
            amrId,
            status: 'started',
            totalSteps,
        });
    }

    emitProgress(progressData) {
        const { taskId, amrId, currentStep, totalSteps, currentNode, sourceNode, operation } = progressData;

        return eventEmitter.emit(AMR_EVENTS.TASK_PROGRESS, {
            taskId,
            amrId,
            status: 'in_progress',
            currentStep,
            totalSteps,
            currentNode,
            sourceNode,
            operation: operation || null,
        });
    }

    emitCompleted(taskData) {
        const { taskId, amrId, totalSteps } = taskData;

        return eventEmitter.emit(AMR_EVENTS.TASK_COMPLETED, {
            taskId,
            amrId,
            status: 'completed',
            totalSteps,
        });
    }

    emitFailed(errorData) {
        const { taskId, amrId, error } = errorData;

        return eventEmitter.emit(AMR_EVENTS.TASK_FAILED, {
            taskId,
            amrId,
            status: 'failed',
            error,
        });
    }
}

module.exports = new AMREventHandler();
