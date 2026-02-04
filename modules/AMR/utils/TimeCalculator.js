class TimeCalculator {
    static now() {
        return Date.now();
    }

    static addMilliseconds(timestamp, ms) {
        return timestamp + ms;
    }

    static isExpired(expiryTime) {
        return Date.now() > expiryTime;
    }

    static getElapsedTime(startTime) {
        return Date.now() - startTime;
    }

    static getRemainingTime(expiryTime) {
        const remaining = expiryTime - Date.now();
        return remaining > 0 ? remaining : 0;
    }

    static formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        }
        if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }
        return `${seconds}s`;
    }
}

module.exports = TimeCalculator;
