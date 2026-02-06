const redis = require('../../../redis/init.redis');
const { logger } = require('../../../config/logger');

const REDIS_KEY_PREFIX = 'lifter:';

class LifterRedisRepository {
    _buildKey(lifterId) {
        return `${REDIS_KEY_PREFIX}${lifterId}:status`;
    }

    async saveStatus(lifterId, statusData) {
        try {
            const key = this._buildKey(lifterId);
            await redis.set(key, JSON.stringify(statusData));
            return true;
        } catch (error) {
            logger.error(`[LifterRedisRepo] Save status error: ${error.message}`);
            return false;
        }
    }

    async getStatus(lifterId) {
        try {
            const key = this._buildKey(lifterId);
            const data = await redis.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.error(`[LifterRedisRepo] Get status error: ${error.message}`);
            return null;
        }
    }

    async reserve(lifterId, shuttleId, targetFloor) {
        try {
            const status = await this.getStatus(lifterId);
            if (!status) return false;

            status.reservedBy = shuttleId;
            status.reservedFloor = targetFloor;
            status.reservedAt = new Date().toISOString();

            return await this.saveStatus(lifterId, status);
        } catch (error) {
            logger.error(`[LifterRedisRepo] Reserve error: ${error.message}`);
            return false;
        }
    }

    async releaseReservation(lifterId, shuttleId) {
        try {
            const status = await this.getStatus(lifterId);
            if (!status || status.reservedBy !== shuttleId) return false;

            delete status.reservedBy;
            delete status.reservedFloor;
            delete status.reservedAt;

            return await this.saveStatus(lifterId, status);
        } catch (error) {
            logger.error(`[LifterRedisRepo] Release error: ${error.message}`);
            return false;
        }
    }
}

module.exports = new LifterRedisRepository();
