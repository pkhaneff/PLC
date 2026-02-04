class DataPoller {
    constructor(name, fetchFn, saveFn, intervalMs) {
        this.name = name;
        this.fetchFn = fetchFn;
        this.saveFn = saveFn;
        this.intervalMs = intervalMs;
        this.intervalId = null;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) {
            console.warn(`[DataPoller] ${this.name} is already running`);
            return;
        }

        this.isRunning = true;
        this._poll();
        this.intervalId = setInterval(() => this._poll(), this.intervalMs);
        console.log(`[DataPoller] ${this.name} started (interval: ${this.intervalMs}ms)`);
    }

    stop() {
        if (!this.isRunning) {
            return;
        }

        clearInterval(this.intervalId);
        this.intervalId = null;
        this.isRunning = false;
        console.log(`[DataPoller] ${this.name} stopped`);
    }

    setInterval(intervalMs) {
        this.intervalMs = intervalMs;
        if (this.isRunning) {
            this.stop();
            this.start();
        }
    }

    async _poll() {
        try {
            const data = await this.fetchFn();
            await this.saveFn(data);
        } catch (error) {
            console.error(`[DataPoller] ${this.name} error:`, error.message);
        }
    }
}

module.exports = DataPoller;
