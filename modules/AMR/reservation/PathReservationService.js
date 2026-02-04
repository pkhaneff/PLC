const ReservationRepository = require('./ReservationRepository');
const ReservationValidator = require('./ReservationValidator');
const TimeCalculator = require('../utils/TimeCalculator');
const AMRLogger = require('../utils/AMRLogger');
const config = require('../config/amr.dispatcher.config');

class PathReservationService {
    async reservePath(amrId, path, taskId) {
        try {
            ReservationValidator.validatePathStructure(path);

            const validation = await ReservationValidator.canReservePath(path, amrId);

            if (!validation.canReserve) {
                AMRLogger.reservation('Path reservation blocked', {
                    amrId,
                    blockedNode: validation.blockedNode,
                    blockedBy: validation.blockedBy
                });
                return { success: false, ...validation };
            }

            const expiresAt = TimeCalculator.addMilliseconds(
                TimeCalculator.now(),
                config.reservation.expiryTime
            );

            for (const nodeId of path) {
                await ReservationRepository.reserveNode(nodeId, amrId, taskId, expiresAt);
            }

            await ReservationRepository.setPath(amrId, path);

            AMRLogger.reservation('Path reserved', {
                amrId,
                taskId,
                nodeCount: path.length
            });

            return { success: true, expiresAt };
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to reserve path', error);
            return { success: false, error: error.message };
        }
    }

    async releasePath(amrId) {
        try {
            await ReservationRepository.releaseAllByAMR(amrId);

            AMRLogger.reservation('Path released', { amrId });
            return true;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to release path', error);
            return false;
        }
    }

    async isPathAvailable(path, excludeAMR = null) {
        try {
            const validation = await ReservationValidator.canReservePath(path, excludeAMR);
            return validation.canReserve;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to check path availability', error);
            return false;
        }
    }

    async getReservationOwner(nodeId) {
        try {
            const reservation = await ReservationRepository.getReservation(nodeId);
            return reservation ? reservation.amrId : null;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to get reservation owner', error);
            return null;
        }
    }

    async getReservedPath(amrId) {
        return await ReservationRepository.getPath(amrId);
    }

    async getConflictingNodes(path, amrId) {
        return await ReservationValidator.getConflictingNodes(path, amrId);
    }
}

module.exports = new PathReservationService();
