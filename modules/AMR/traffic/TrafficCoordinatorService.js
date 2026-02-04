const WaitingQueueManager = require('./WaitingQueueManager');
const PassageGranter = require('./PassageGranter');
const PriorityResolver = require('./PriorityResolver');
const AMRLogger = require('../utils/AMRLogger');

class TrafficCoordinatorService {
    async requestPassage(amrId, nodeId, context = {}) {
        try {
            const passageResult = await PassageGranter.requestPassage(amrId, nodeId);

            if (passageResult.granted) {
                return { allowed: true };
            }

            const priority = context.priority || 0;
            const position = WaitingQueueManager.addToQueue(nodeId, amrId, priority);

            AMRLogger.traffic('AMR waiting for passage', {
                amrId,
                nodeId,
                queuePosition: position + 1
            });

            return {
                allowed: false,
                waiting: true,
                queuePosition: position,
                blockedBy: passageResult.reservedBy
            };
        } catch (error) {
            AMRLogger.error('Traffic', 'Failed to request passage', error);
            return { allowed: false, error: error.message };
        }
    }

    async grantPassage(amrId, nodeId) {
        try {
            const granted = await PassageGranter.grantPassage(amrId, nodeId);

            if (granted) {
                WaitingQueueManager.removeFromQueue(nodeId, amrId);
            }

            return granted;
        } catch (error) {
            AMRLogger.error('Traffic', 'Failed to grant passage', error);
            return false;
        }
    }

    async resolveConflict(amr1, amr2, context = {}) {
        try {
            const resolution = PriorityResolver.resolveConflict(amr1, amr2, context);

            AMRLogger.traffic('Conflict resolved', {
                winner: resolution.winner,
                loser: resolution.loser,
                priorityDiff: resolution.priorityDiff
            });

            return resolution;
        } catch (error) {
            AMRLogger.error('Traffic', 'Failed to resolve conflict', error);
            return null;
        }
    }

    getWaitingQueues() {
        return WaitingQueueManager.getAllQueues();
    }

    clearWaitingQueue(nodeId) {
        WaitingQueueManager.clearQueue(nodeId);
    }

    getQueuePosition(nodeId, amrId) {
        return WaitingQueueManager.getQueuePosition(nodeId, amrId);
    }
}

module.exports = new TrafficCoordinatorService();
