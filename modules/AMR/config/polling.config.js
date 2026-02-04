module.exports = {
    intervals: {
        location: 1000,
        battery: 5000,
        cargo: 3000,
        status: 2000,
        sensors: 2000,
    },

    retry: {
        maxAttempts: 3,
        backoffMs: 1000,
    },

    timeout: {
        default: 5000,
        long: 10000,
    },
};
