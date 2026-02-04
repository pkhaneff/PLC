const config = require('../config/amr.dispatcher.config');

class TaskPriorityCalculator {
    calculatePriority(task, context = {}) {
        if (config.queue.type === 'FIFO') {
            return task.createdAt || Date.now();
        }

        const urgency = this.getUrgencyScore(task);
        const distance = this.getDistanceScore(task, context);
        const waiting = this.getWaitingScore(task);

        return urgency * 0.5 + distance * 0.3 + waiting * 0.2;
    }

    getUrgencyScore(task) {
        const urgencyLevels = {
            'CRITICAL': 100,
            'HIGH': 75,
            'NORMAL': 50,
            'LOW': 25
        };

        return urgencyLevels[task.urgency] || urgencyLevels['NORMAL'];
    }

    getDistanceScore(task, context) {
        if (!context.amrPosition || !task.pickupNode) {
            return 50;
        }

        const maxDistance = 1000;
        const distance = context.distance || 0;

        return Math.max(0, 100 - (distance / maxDistance) * 100);
    }

    getWaitingScore(task) {
        const createdAt = task.createdAt || Date.now();
        const waitingTime = Date.now() - createdAt;
        const maxWait = 300000;

        return Math.min(100, (waitingTime / maxWait) * 100);
    }
}

module.exports = new TaskPriorityCalculator();
