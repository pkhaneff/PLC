const redisClient = require('../../../redis/init.redis');
const AMRLogger = require('../utils/AMRLogger');

class StateRepository {
    constructor() {
        this.statePrefix = 'amr:state:';
        this.allStatesKey = 'amr:states:all';
    }

    async setState(amrId, state) {
        try {
            const stateKey = `${this.statePrefix}${amrId}`;

            await redisClient.set(stateKey, JSON.stringify(state));
            await redisClient.sAdd(this.allStatesKey, amrId);

            AMRLogger.state('State updated', { amrId, status: state.status });
            return true;
        } catch (error) {
            AMRLogger.error('State', 'Failed to set state', error);
            throw error;
        }
    }

    async getState(amrId) {
        try {
            const stateKey = `${this.statePrefix}${amrId}`;
            const stateData = await redisClient.get(stateKey);

            return stateData ? JSON.parse(stateData) : null;
        } catch (error) {
            AMRLogger.error('State', 'Failed to get state', error);
            return null;
        }
    }

    async getAllStates() {
        try {
            const amrIds = await redisClient.sMembers(this.allStatesKey);
            const states = [];

            for (const amrId of amrIds) {
                const state = await this.getState(amrId);
                if (state) {
                    states.push(state);
                }
            }

            return states;
        } catch (error) {
            AMRLogger.error('State', 'Failed to get all states', error);
            return [];
        }
    }

    async updateState(amrId, updates) {
        try {
            const currentState = await this.getState(amrId);
            if (!currentState) return false;

            const updatedState = { ...currentState, ...updates };
            await this.setState(amrId, updatedState);

            return true;
        } catch (error) {
            AMRLogger.error('State', 'Failed to update state', error);
            return false;
        }
    }

    async deleteState(amrId) {
        try {
            const stateKey = `${this.statePrefix}${amrId}`;

            await redisClient.del(stateKey);
            await redisClient.sRem(this.allStatesKey, amrId);

            AMRLogger.state('State deleted', { amrId });
            return true;
        } catch (error) {
            AMRLogger.error('State', 'Failed to delete state', error);
            return false;
        }
    }

    async getStatesByStatus(status) {
        try {
            const allStates = await this.getAllStates();
            return allStates.filter(state => state.status === status);
        } catch (error) {
            AMRLogger.error('State', 'Failed to get states by status', error);
            return [];
        }
    }
}

module.exports = new StateRepository();
