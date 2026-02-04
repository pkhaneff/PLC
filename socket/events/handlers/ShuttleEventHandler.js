const eventEmitter = require('../EventEmitter');
const { SHUTTLE_EVENTS } = require('../EventTypes');
const { logger } = require('../../../config/logger');

class ShuttleEventHandler {
    emitTaskQueued(taskData) {
        const { taskId, shuttleId, pickupNode, endNode } = taskData;

        return eventEmitter.emit(SHUTTLE_EVENTS.TASK_QUEUED, {
            taskId,
            shuttleId,
            status: 'queued',
            pickupNode,
            endNode,
        });
    }

    emitTaskAssigned(taskData) {
        const { taskId, shuttleId, pathLength } = taskData;

        return eventEmitter.emit(SHUTTLE_EVENTS.TASK_ASSIGNED, {
            taskId,
            shuttleId,
            status: 'assigned',
            pathLength,
        });
    }

    emitTaskStarted(taskData) {
        const { taskId, shuttleId } = taskData;

        return eventEmitter.emit(SHUTTLE_EVENTS.TASK_STARTED, {
            taskId,
            shuttleId,
            status: 'started',
        });
    }

    emitTaskProgress(progressData) {
        const { taskId, shuttleId, currentNode, progress } = progressData;

        return eventEmitter.emit(SHUTTLE_EVENTS.TASK_PROGRESS, {
            taskId,
            shuttleId,
            status: 'in_progress',
            currentNode,
            progress,
        });
    }

    emitTaskCompleted(taskData) {
        const { taskId, shuttleId } = taskData;

        return eventEmitter.emit(SHUTTLE_EVENTS.TASK_COMPLETED, {
            taskId,
            shuttleId,
            status: 'completed',
        });
    }

    emitTaskFailed(errorData) {
        const { taskId, shuttleId, error } = errorData;

        return eventEmitter.emit(SHUTTLE_EVENTS.TASK_FAILED, {
            taskId,
            shuttleId,
            status: 'failed',
            error,
        });
    }

    emitStateUpdated(stateData) {
        return eventEmitter.emit(SHUTTLE_EVENTS.STATE_UPDATED, stateData);
    }
}

module.exports = new ShuttleEventHandler();
