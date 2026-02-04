const AMRLogger = require('../utils/AMRLogger');
const TimeCalculator = require('../utils/TimeCalculator');

class WaitingQueueManager {
    constructor() {
        this.queues = new Map();
    }

    addToQueue(nodeId, amrId, priority = 0) {
        if (!this.queues.has(nodeId)) {
            this.queues.set(nodeId, []);
        }

        const queue = this.queues.get(nodeId);

        queue.push({
            amrId,
            priority,
            addedAt: TimeCalculator.now()
        });

        queue.sort((a, b) => b.priority - a.priority);

        AMRLogger.traffic('AMR added to waiting queue', {
            nodeId,
            amrId,
            position: queue.findIndex(item => item.amrId === amrId) + 1
        });

        return queue.findIndex(item => item.amrId === amrId);
    }

    removeFromQueue(nodeId, amrId) {
        if (!this.queues.has(nodeId)) return false;

        const queue = this.queues.get(nodeId);
        const index = queue.findIndex(item => item.amrId === amrId);

        if (index === -1) return false;

        queue.splice(index, 1);

        if (queue.length === 0) {
            this.queues.delete(nodeId);
        }

        AMRLogger.traffic('AMR removed from waiting queue', { nodeId, amrId });
        return true;
    }

    getNextInQueue(nodeId) {
        if (!this.queues.has(nodeId)) return null;

        const queue = this.queues.get(nodeId);
        return queue.length > 0 ? queue[0].amrId : null;
    }

    getQueuePosition(nodeId, amrId) {
        if (!this.queues.has(nodeId)) return -1;

        const queue = this.queues.get(nodeId);
        return queue.findIndex(item => item.amrId === amrId);
    }

    getQueueLength(nodeId) {
        if (!this.queues.has(nodeId)) return 0;
        return this.queues.get(nodeId).length;
    }

    isInQueue(nodeId, amrId) {
        return this.getQueuePosition(nodeId, amrId) !== -1;
    }

    clearQueue(nodeId) {
        this.queues.delete(nodeId);
        AMRLogger.traffic('Queue cleared', { nodeId });
    }

    getAllQueues() {
        const result = {};

        for (const [nodeId, queue] of this.queues) {
            result[nodeId] = queue.map(item => ({
                amrId: item.amrId,
                priority: item.priority,
                waitingTime: TimeCalculator.getElapsedTime(item.addedAt)
            }));
        }

        return result;
    }
}

module.exports = new WaitingQueueManager();
