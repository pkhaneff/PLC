module.exports = {
    dispatcher: {
        interval: 5000,
        retryInterval: 2000,
        maxRetries: 10
    },

    reservation: {
        expiryTime: 300000,
        cleanupInterval: 60000,
        strategy: 'FULL_PATH'
    },

    traffic: {
        priorityWeights: {
            distanceToGoal: 0.4,
            taskUrgency: 0.3,
            waitingTime: 0.2,
            cargoValue: 0.1
        },
        maxWaitingTime: 180000
    },

    conflict: {
        detectionEnabled: true,
        deadlockCheckInterval: 30000,
        conflictTypes: {
            HEAD_ON: 'HEAD_ON_COLLISION',
            INTERSECTION: 'INTERSECTION_CONFLICT',
            FOLLOWING: 'FOLLOWING_CONFLICT',
            DEADLOCK: 'CIRCULAR_WAIT'
        }
    },

    queue: {
        type: 'FIFO',
        maxSize: 1000
    },

    pathfinding: {
        algorithm: 'A_STAR',
        maxAlternatives: 3,
        avoidReservedNodes: true
    }
};
