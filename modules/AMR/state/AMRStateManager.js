const StateRepository = require('./StateRepository');
const StateValidator = require('./StateValidator');
const AMRLogger = require('../utils/AMRLogger');

class AMRStateManager {
    async updateState(amrId, updates) {
        try {
            const currentState = await StateRepository.getState(amrId);

            if (!currentState) {
                const newState = {
                    amrId,
                    currentNode: updates.currentNode || null,
                    status: 'IDLE',
                    currentTask: null,
                    reservedPath: [],
                    battery: updates.battery || 100,
                    cargo: updates.cargo || null,
                    updatedAt: Date.now()
                };

                StateValidator.validateState(newState);
                await StateRepository.setState(amrId, newState);

                AMRLogger.state('State initialized', { amrId });
                return newState;
            }

            if (updates.status && updates.status !== currentState.status) {
                const canChange = await StateValidator.canChangeStatus(amrId, updates.status);
                if (!canChange) {
                    throw new Error(
                        `Invalid transition: ${currentState.status} -> ${updates.status}`
                    );
                }
            }

            const updatedState = {
                ...currentState,
                ...updates,
                updatedAt: Date.now()
            };

            await StateRepository.setState(amrId, updatedState);
            return updatedState;
        } catch (error) {
            AMRLogger.error('StateManager', 'Failed to update state', error);
            throw error;
        }
    }

    async getState(amrId) {
        return await StateRepository.getState(amrId);
    }

    async getAllStates() {
        return await StateRepository.getAllStates();
    }

    async getIdleAMRs() {
        return await StateRepository.getStatesByStatus('IDLE');
    }

    async getAMRsByStatus(status) {
        return await StateRepository.getStatesByStatus(status);
    }

    async setCurrentTask(amrId, taskId) {
        return await StateRepository.updateState(amrId, {
            currentTask: taskId,
            status: 'MOVING'
        });
    }

    async clearCurrentTask(amrId) {
        return await StateRepository.updateState(amrId, {
            currentTask: null,
            status: 'IDLE',
            reservedPath: []
        });
    }

    async setReservedPath(amrId, path) {
        return await StateRepository.updateState(amrId, { reservedPath: path });
    }
}

module.exports = new AMRStateManager();
