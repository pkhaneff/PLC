const ReservationRepository = require('../reservation/ReservationRepository');
const AMRLogger = require('../utils/AMRLogger');

class PassageGranter {
    async canGrantPassage(amrId, nodeId) {
        try {
            const isReserved = await ReservationRepository.isNodeReserved(nodeId, amrId);

            if (!isReserved) {
                return { granted: true, reason: 'Node available' };
            }

            const reservation = await ReservationRepository.getReservation(nodeId);

            return {
                granted: false,
                reason: 'Node reserved',
                reservedBy: reservation.amrId,
                taskId: reservation.taskId
            };
        } catch (error) {
            AMRLogger.error('PassageGranter', 'Failed to check passage', error);
            return { granted: false, reason: 'Error checking reservation' };
        }
    }

    async grantPassage(amrId, nodeId) {
        const check = await this.canGrantPassage(amrId, nodeId);

        if (check.granted) {
            AMRLogger.traffic('Passage granted', { amrId, nodeId });
            return true;
        }

        AMRLogger.traffic('Passage denied', {
            amrId,
            nodeId,
            reason: check.reason,
            reservedBy: check.reservedBy
        });

        return false;
    }

    async requestPassage(amrId, nodeId) {
        const result = await this.canGrantPassage(amrId, nodeId);

        AMRLogger.traffic('Passage requested', {
            amrId,
            nodeId,
            granted: result.granted
        });

        return result;
    }
}

module.exports = new PassageGranter();
