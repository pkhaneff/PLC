class PollerManager {
    constructor() {
        this.pollers = new Map();
    }

    addPoller(name, poller) {
        if (this.pollers.has(name)) {
            console.warn(`[PollerManager] Poller ${name} already exists`);
            return;
        }

        this.pollers.set(name, poller);
        console.log(`[PollerManager] Added poller: ${name}`);
    }

    removePoller(name) {
        const poller = this.pollers.get(name);
        if (poller) {
            poller.stop();
            this.pollers.delete(name);
            console.log(`[PollerManager] Removed poller: ${name}`);
        }
    }

    start(name) {
        const poller = this.pollers.get(name);
        if (poller) {
            poller.start();
        } else {
            console.error(`[PollerManager] Poller ${name} not found`);
        }
    }

    stop(name) {
        const poller = this.pollers.get(name);
        if (poller) {
            poller.stop();
        }
    }

    startAll() {
        console.log(`[PollerManager] Starting ${this.pollers.size} pollers`);
        this.pollers.forEach((poller) => poller.start());
    }

    stopAll() {
        console.log(`[PollerManager] Stopping all pollers`);
        this.pollers.forEach((poller) => poller.stop());
        this.pollers.clear();
    }

    getPoller(name) {
        return this.pollers.get(name);
    }
}

module.exports = PollerManager;
