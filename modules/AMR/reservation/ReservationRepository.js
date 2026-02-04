const redisClient = require('../../../redis/init.redis');
const AMRLogger = require('../utils/AMRLogger');

class ReservationRepository {
    constructor() {
        this.reservationPrefix = 'amr:reservation:';
        this.pathPrefix = 'amr:path:';
        this.allReservationsKey = 'amr:reservations:all';
    }

    async reserveNode(nodeId, amrId, taskId, expiresAt) {
        try {
            const reservationKey = `${this.reservationPrefix}${nodeId}`;
            const reservation = {
                amrId,
                taskId,
                reservedAt: Date.now(),
                expiresAt
            };

            await redisClient.set(reservationKey, JSON.stringify(reservation));
            await redisClient.sAdd(this.allReservationsKey, nodeId);

            return true;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to reserve node', error);
            throw error;
        }
    }

    async releaseNode(nodeId) {
        try {
            const reservationKey = `${this.reservationPrefix}${nodeId}`;

            await redisClient.del(reservationKey);
            await redisClient.sRem(this.allReservationsKey, nodeId);

            return true;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to release node', error);
            return false;
        }
    }

    async getReservation(nodeId) {
        try {
            const reservationKey = `${this.reservationPrefix}${nodeId}`;
            const data = await redisClient.get(reservationKey);

            return data ? JSON.parse(data) : null;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to get reservation', error);
            return null;
        }
    }

    async isNodeReserved(nodeId, excludeAMR = null) {
        try {
            const reservation = await this.getReservation(nodeId);

            if (!reservation) return false;
            if (excludeAMR && reservation.amrId === excludeAMR) return false;

            return true;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to check reservation', error);
            return false;
        }
    }

    async setPath(amrId, path) {
        try {
            const pathKey = `${this.pathPrefix}${amrId}`;
            await redisClient.set(pathKey, JSON.stringify(path));

            return true;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to set path', error);
            return false;
        }
    }

    async getPath(amrId) {
        try {
            const pathKey = `${this.pathPrefix}${amrId}`;
            const data = await redisClient.get(pathKey);

            return data ? JSON.parse(data) : null;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to get path', error);
            return null;
        }
    }

    async deletePath(amrId) {
        try {
            const pathKey = `${this.pathPrefix}${amrId}`;
            await redisClient.del(pathKey);

            return true;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to delete path', error);
            return false;
        }
    }

    async getAllReservations() {
        try {
            const nodeIds = await redisClient.sMembers(this.allReservationsKey);
            const reservations = [];

            for (const nodeId of nodeIds) {
                const reservation = await this.getReservation(nodeId);
                if (reservation) {
                    reservations.push({ nodeId, ...reservation });
                }
            }

            return reservations;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to get all reservations', error);
            return [];
        }
    }

    async releaseAllByAMR(amrId) {
        try {
            const allReservations = await this.getAllReservations();
            const amrReservations = allReservations.filter(r => r.amrId === amrId);

            for (const reservation of amrReservations) {
                await this.releaseNode(reservation.nodeId);
            }

            await this.deletePath(amrId);

            AMRLogger.reservation('Released all reservations', { amrId, count: amrReservations.length });
            return true;
        } catch (error) {
            AMRLogger.error('Reservation', 'Failed to release all by AMR', error);
            return false;
        }
    }
}

module.exports = new ReservationRepository();
