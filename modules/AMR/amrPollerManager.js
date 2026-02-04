const AMRClient = require('./client/AMRClient');
const AMRPoller = require('./polling/AMRPoller');
const RedisStorage = require('./storage/RedisStorage');

class AMRPollerManager {
    constructor() {
        this.pollers = new Map();
        this.storage = new RedisStorage();
    }

    addAMR(amrConfig) {
        if (this.pollers.has(amrConfig.id)) {
            console.warn(`AMR ${amrConfig.id} already exists`);
            return;
        }

        const client = new AMRClient(amrConfig.id, amrConfig.ip);
        const poller = new AMRPoller(client, this.storage);

        this.pollers.set(amrConfig.id, poller);
        console.log(`Added AMR ${amrConfig.id}`);
    }

    start(amrId) {
        const poller = this.pollers.get(amrId);
        if (!poller) {
            console.error(`AMR ${amrId} not found`);
            return;
        }
        poller.start();
    }

    startAll() {
        console.log(`Starting ${this.pollers.size} AMR pollers`);
        this.pollers.forEach(poller => poller.start());
    }

    stop(amrId) {
        const poller = this.pollers.get(amrId);
        if (poller) poller.stop();
    }

    stopAll() {
        console.log('Stopping all pollers');
        this.pollers.forEach(poller => poller.stop());
        this.storage.disconnect();
    }

    async getAMRData(amrId) {
        const poller = this.pollers.get(amrId);
        return poller ? await poller.getCurrentData() : null;
    }

    async getAllAMRData() {
        const data = {};
        for (const [amrId, poller] of this.pollers) {
            data[amrId] = await poller.getCurrentData();
        }
        return data;
    }
}

module.exports = new AMRPollerManager();
