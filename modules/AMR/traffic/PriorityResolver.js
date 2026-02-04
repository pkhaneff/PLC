const DistanceCalculator = require('../utils/DistanceCalculator');
const TimeCalculator = require('../utils/TimeCalculator');
const config = require('../config/amr.dispatcher.config');

class PriorityResolver {
    calculatePriority(amr, context = {}) {
        const distanceScore = this.getDistanceToGoalScore(amr, context);
        const urgencyScore = this.getTaskUrgencyScore(amr);
        const waitingScore = this.getWaitingTimeScore(amr);
        const cargoScore = this.getCargoValueScore(amr);

        const weights = config.traffic.priorityWeights;

        return (
            distanceScore * weights.distanceToGoal +
            urgencyScore * weights.taskUrgency +
            waitingScore * weights.waitingTime +
            cargoScore * weights.cargoValue
        );
    }

    getDistanceToGoalScore(amr, context) {
        if (!context.graph || !amr.reservedPath) return 50;

        const remainingPath = amr.reservedPath;
        const pathLength = DistanceCalculator.pathLength(remainingPath, context.graph);

        const maxDistance = 1000;
        return Math.max(0, 100 - (pathLength / maxDistance) * 100);
    }

    getTaskUrgencyScore(amr) {
        const urgencyLevels = {
            'CRITICAL': 100,
            'HIGH': 75,
            'NORMAL': 50,
            'LOW': 25
        };

        return urgencyLevels[amr.taskUrgency] || urgencyLevels['NORMAL'];
    }

    getWaitingTimeScore(amr) {
        if (!amr.waitingSince) return 0;

        const waitingTime = TimeCalculator.getElapsedTime(amr.waitingSince);
        const maxWait = config.traffic.maxWaitingTime;

        return Math.min(100, (waitingTime / maxWait) * 100);
    }

    getCargoValueScore(amr) {
        if (!amr.cargo || !amr.cargo.value) return 0;

        const maxValue = 10000;
        return Math.min(100, (amr.cargo.value / maxValue) * 100);
    }

    resolveConflict(amr1, amr2, context = {}) {
        const priority1 = this.calculatePriority(amr1, context);
        const priority2 = this.calculatePriority(amr2, context);

        if (priority1 > priority2) {
            return {
                winner: amr1.amrId,
                loser: amr2.amrId,
                priorityDiff: priority1 - priority2
            };
        }

        return {
            winner: amr2.amrId,
            loser: amr1.amrId,
            priorityDiff: priority2 - priority1
        };
    }
}

module.exports = new PriorityResolver();
