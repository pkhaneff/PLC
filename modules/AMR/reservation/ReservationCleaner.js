const ReservationRepository = require('./ReservationRepository');
const TimeCalculator = require('../utils/TimeCalculator');
const AMRLogger = require('../utils/AMRLogger');
const config = require('../config/amr.dispatcher.config');

class ReservationCleaner {
    constructor() {
        this.cleanupTimer = null;
    }

    async cleanupExpired() {
        try {
            const allReservations = await ReservationRepository.getAllReservations();
            let cleanedCount = 0;

            for (const reservation of allReservations) {
                if (TimeCalculator.isExpired(reservation.expiresAt)) {
                    await ReservationRepository.releaseNode(reservation.nodeId);
                    cleanedCount++;

                    AMRLogger.debug('Cleaner', 'Expired reservation cleaned', {
                        nodeId: reservation.nodeId,
                        amrId: reservation.amrId
                    });
                }
            }

            if (cleanedCount > 0) {
                AMRLogger.reservation('Cleanup completed', { cleanedCount });
            }

            return cleanedCount;
        } catch (error) {
            AMRLogger.error('Cleaner', 'Cleanup failed', error);
            return 0;
        }
    }

    async forceRelease(amrId) {
        try {
            await ReservationRepository.releaseAllByAMR(amrId);
            AMRLogger.reservation('Force released', { amrId });
            return true;
        } catch (error) {
            AMRLogger.error('Cleaner', 'Force release failed', error);
            return false;
        }
    }

    start() {
        if (this.cleanupTimer) {
            AMRLogger.debug('Cleaner', 'Already running');
            return;
        }

        this.cleanupTimer = setInterval(
            () => this.cleanupExpired(),
            config.reservation.cleanupInterval
        );

        AMRLogger.reservation('Cleaner started', {
            interval: config.reservation.cleanupInterval
        });
    }

    stop() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
            AMRLogger.reservation('Cleaner stopped');
        }
    }
}

module.exports = new ReservationCleaner();
