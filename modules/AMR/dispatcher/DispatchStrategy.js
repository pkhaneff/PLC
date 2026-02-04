const AMRStateManager = require('../state/AMRStateManager');
const DistanceCalculator = require('../utils/DistanceCalculator');

class DispatchStrategy {
    async selectNextTask(tasks) {
        if (!tasks || tasks.length === 0) return null;

        return tasks[0];
    }

    async selectOptimalAMR(amrs, task, graph) {
        if (!amrs || amrs.length === 0) return null;
        if (amrs.length === 1) return amrs[0];

        let optimalAMR = null;
        let minDistance = Infinity;

        for (const amr of amrs) {
            const distance = this.calculateDistance(amr, task, graph);

            if (distance < minDistance) {
                minDistance = distance;
                optimalAMR = amr;
            }
        }

        return optimalAMR;
    }

    calculateDistance(amr, task, graph) {
        if (!graph || !amr.currentNode || !task.pickupNode) {
            return Infinity;
        }

        const amrNode = graph.getNode(amr.currentNode);
        const taskNode = graph.getNode(task.pickupNode);

        if (!amrNode || !taskNode) return Infinity;

        return DistanceCalculator.manhattan(amrNode, taskNode);
    }

    async shouldRetryAssignment(task, failureCount) {
        const maxRetries = 10;
        return failureCount < maxRetries;
    }

    getRetryDelay(failureCount) {
        const baseDelay = 2000;
        return baseDelay * Math.min(failureCount, 5);
    }
}

module.exports = new DispatchStrategy();
