const StateRepository = require('./StateRepository');
const AMRLogger = require('../utils/AMRLogger');

class StateValidator {
    static isValidTransition(currentStatus, newStatus) {
        const validTransitions = {
            'IDLE': ['MOVING', 'LOADING'],
            'MOVING': ['IDLE', 'LOADING', 'UNLOADING'],
            'LOADING': ['MOVING', 'IDLE'],
            'UNLOADING': ['MOVING', 'IDLE']
        };

        const allowed = validTransitions[currentStatus];
        return allowed && allowed.includes(newStatus);
    }

    static validateState(state) {
        const required = ['amrId', 'currentNode', 'status'];

        for (const field of required) {
            if (!state[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        const validStatuses = ['IDLE', 'MOVING', 'LOADING', 'UNLOADING'];
        if (!validStatuses.includes(state.status)) {
            throw new Error(`Invalid status: ${state.status}`);
        }

        return true;
    }

    static async canChangeStatus(amrId, newStatus) {
        const currentState = await StateRepository.getState(amrId);

        if (!currentState) {
            return newStatus === 'IDLE';
        }

        return this.isValidTransition(currentState.status, newStatus);
    }
}

module.exports = StateValidator;
