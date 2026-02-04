const redis = require('../../../redis/init.redis');

class RedisStorage {
    constructor() {
        this.client = redis;
    }

    async save(key, data, ttl = null) {
        try {
            const serialized = JSON.stringify(data);
            if (ttl) {
                await this.client.setex(key, ttl, serialized);
            } else {
                await this.client.set(key, serialized);
            }
        } catch (error) {
            console.error(`[RedisStorage] Save error for key ${key}:`, error.message);
            throw error;
        }
    }

    async get(key) {
        try {
            const data = await this.client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error(`[RedisStorage] Get error for key ${key}:`, error.message);
            return null;
        }
    }

    async delete(key) {
        try {
            await this.client.del(key);
        } catch (error) {
            console.error(`[RedisStorage] Delete error for key ${key}:`, error.message);
        }
    }

    async exists(key) {
        try {
            const result = await this.client.exists(key);
            return result === 1;
        } catch (error) {
            console.error(`[RedisStorage] Exists error for key ${key}:`, error.message);
            return false;
        }
    }

    disconnect() {
        console.log('[RedisStorage] Disconnecting...');
    }
}

module.exports = RedisStorage;
