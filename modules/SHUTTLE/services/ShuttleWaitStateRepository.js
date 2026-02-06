const redis = require('../../../redis/init.redis');
const { logger } = require('../../../config/logger');

const WAIT_STATE_PREFIX = 'shuttle:';
const WAIT_STATE_SUFFIX = ':wait_state';

class ShuttleWaitStateRepository {
    _buildKey(shuttleId) {
        return `${WAIT_STATE_PREFIX}${shuttleId}${WAIT_STATE_SUFFIX}`;
    }

    async setWaitState(shuttleId, waitContext) {
        try {
            const key = this._buildKey(shuttleId);
            const data = {
                isWaiting: true,
                ...waitContext,
                setAt: new Date().toISOString(),
            };

            await redis.set(key, JSON.stringify(data));
            return true;
        } catch (error) {
            logger.error(`[WaitStateRepo] Set error: ${error.message}`);
            return false;
        }
    }

    async getWaitState(shuttleId) {
        try {
            const key = this._buildKey(shuttleId);
            const data = await redis.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.error(`[WaitStateRepo] Get error: ${error.message}`);
            return null;
        }
    }

    async clearWaitState(shuttleId) {
        try {
            const key = this._buildKey(shuttleId);
            await redis.del(key);
            return true;
        } catch (error) {
            logger.error(`[WaitStateRepo] Clear error: ${error.message}`);
            return false;
        }
    }

    async getAllWaitingShuttles() {
        try {
            const pattern = `${WAIT_STATE_PREFIX}*${WAIT_STATE_SUFFIX}`;
            const keys = await redis.keys(pattern);

            const waitingShuttles = [];
            for (const key of keys) {
                const data = await redis.get(key);
                if (data) {
                    const parsed = JSON.parse(data);
                    const shuttleId = key.replace(WAIT_STATE_PREFIX, '').replace(WAIT_STATE_SUFFIX, '');
                    waitingShuttles.push({ shuttleId, ...parsed });
                }
            }

            return waitingShuttles;
        } catch (error) {
            logger.error(`[WaitStateRepo] Get all error: ${error.message}`);
            return [];
        }
    }
}

module.exports = new ShuttleWaitStateRepository();
