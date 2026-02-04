const ReservationRepository = require('./ReservationRepository');
const AMRLogger = require('../utils/AMRLogger');

class ReservationValidator {
    async canReservePath(path, amrId) {
        try {
            for (const nodeId of path) {
                const isReserved = await ReservationRepository.isNodeReserved(nodeId, amrId);

                if (isReserved) {
                    const reservation = await ReservationRepository.getReservation(nodeId);

                    AMRLogger.debug('Validator', 'Node already reserved', {
                        nodeId,
                        reservedBy: reservation.amrId,
                        requestedBy: amrId
                    });

                    return {
                        canReserve: false,
                        blockedNode: nodeId,
                        blockedBy: reservation.amrId
                    };
                }
            }

            return { canReserve: true };
        } catch (error) {
            AMRLogger.error('Validator', 'Failed to validate reservation', error);
            return { canReserve: false, error: error.message };
        }
    }

    async getConflictingNodes(path, amrId) {
        const conflicts = [];

        for (const nodeId of path) {
            const isReserved = await ReservationRepository.isNodeReserved(nodeId, amrId);

            if (isReserved) {
                const reservation = await ReservationRepository.getReservation(nodeId);
                conflicts.push({
                    nodeId,
                    reservedBy: reservation.amrId,
                    taskId: reservation.taskId
                });
            }
        }

        return conflicts;
    }

    validatePathStructure(path) {
        if (!Array.isArray(path)) {
            throw new Error('Path must be an array');
        }

        if (path.length === 0) {
            throw new Error('Path cannot be empty');
        }

        return true;
    }
}

module.exports = new ReservationValidator();
