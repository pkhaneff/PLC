class DataCache {
    constructor() {
        this.cache = new Map();
        this.expiryTimers = new Map();
    }

    set(key, value, ttl = null) {
        this.cache.set(key, value);

        if (this.expiryTimers.has(key)) {
            clearTimeout(this.expiryTimers.get(key));
        }

        if (ttl) {
            const timer = setTimeout(() => {
                this.cache.delete(key);
                this.expiryTimers.delete(key);
            }, ttl * 1000);

            this.expiryTimers.set(key, timer);
        }
    }

    get(key) {
        return this.cache.get(key) || null;
    }

    delete(key) {
        if (this.expiryTimers.has(key)) {
            clearTimeout(this.expiryTimers.get(key));
            this.expiryTimers.delete(key);
        }
        this.cache.delete(key);
    }

    exists(key) {
        return this.cache.has(key);
    }

    clear() {
        this.expiryTimers.forEach((timer) => clearTimeout(timer));
        this.expiryTimers.clear();
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

module.exports = DataCache;
