const redisClient = require('../../redis/init.redis');
const { logger } = require('../../config/logger');
const { lifterService } = require('../../core/bootstrap');

const LIFTER_QUEUE_KEY = 'lifter:coordinated_queue';
const LIFTER_STATUS_KEY = 'lifter:status';

class LifterCoordinationService {
  /**
   * Request the lifter to a specific floor.
   * This is a "call" request, ensuring the lifter comes to the floor.
   * @param {number} floorId - The target floor ID (e.g., 138, 139)
   * @param {string} shuttleId - The shuttle requesting the lifter
   * @param {number} priority - Priority (high for active missions)
   */
  async requestLifter(floorId, shuttleId, priority = 1) {
    try {
      const request = {
        floorId,
        shuttleId,
        priority,
        timestamp: Date.now(),
      };

      // Push to Redis Queue
      // Using a simple List for now, assuming FIFO with priority checking if needed later.
      // For now, FIFO is fine.
      await redisClient.rPush(LIFTER_QUEUE_KEY, JSON.stringify(request));
      logger.info(`[LifterCoordination] Shuttle ${shuttleId} requested lifter to floor ${floorId}`);

      // Trigger processing immediately
      this.processQueue();

      return { success: true };
    } catch (error) {
      logger.error(`[LifterCoordination] Error requesting lifter: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process the request queue.
   * Checks if Lifter is busy. If not, picks next request and moves lifter.
   */
  async processQueue() {
    try {
      // 1. Check if Lifter is busy (using a lock or status flag in Redis)
      const isBusy = await redisClient.get(`${LIFTER_STATUS_KEY}:busy`);
      if (isBusy === 'true') {
        return; // Lifter is moving, waits for it to finish
      }

      // 2. Get next request
      const requestJson = await redisClient.lPop(LIFTER_QUEUE_KEY);
      if (!requestJson) {
        return; // Queue empty
      }

      const request = JSON.parse(requestJson);
      const { floorId, shuttleId } = request;

      // 3. Mark busy
      await redisClient.set(`${LIFTER_STATUS_KEY}:busy`, 'true', { EX: 60 }); // 60s safety timeout

      // 4. Update Status for UI/Monitoring
      await redisClient.hSet(LIFTER_STATUS_KEY, {
        status: 'MOVING',
        targetFloor: floorId,
        assignedTo: shuttleId,
      });

      logger.info(`[LifterCoordination] Processing request: Move to F${floorId} for Shuttle ${shuttleId}`);

      // 5. Call existing service to move
      // existing lifterService.moveLifterToFloor performs the move and waits
      try {
        const result = await lifterService.moveLifterToFloor(floorId);

        // 6. Movement Done
        logger.info(`[LifterCoordination] Lifter arrived at F${floorId}`);

        // 7. Update State
        await redisClient.hSet(LIFTER_STATUS_KEY, {
          status: 'IDLE',
          currentFloor: floorId,
          targetFloor: '',
          assignedTo: '',
        });

        // 8. Publish Event for TaskEventListener (via Redis Pub/Sub or Direct internal event?)
        // Since this is a specialized "Lookahead" system, we'll use Redis Pub/Sub for scalability
        // or just rely on the TaskEventListener polling/checking.
        // Better: Publish a Redis event that TaskEventListener listens to.
        // Or: simpler, we know TaskEventListener uses MQTT. We can publish INTERNAL event.
        // Let's use a shared Redis event channel.
        await redisClient.publish(
          'lifter:events',
          JSON.stringify({
            event: 'LIFTER_ARRIVED',
            floorId: floorId,
            shuttleId: shuttleId, // The one who requested it
          }),
        );
      } catch (moveError) {
        logger.error(`[LifterCoordination] Move failed: ${moveError.message}`);
      } finally {
        // 9. Release Busy Lock
        await redisClient.del(`${LIFTER_STATUS_KEY}:busy`);

        // 10. Process next item (if any)
        this.processQueue();
      }
    } catch (error) {
      logger.error(`[LifterCoordination] Error processing queue: ${error.message}`);
      // Ensure lock is released if error occurs before move logic
      await redisClient.del(`${LIFTER_STATUS_KEY}:busy`);
    }
  }

  /**
   * Get current cached lifter status.
   * If cache is missing, attempts to read from PLC/DB via LifterService to populate it.
   */
  async getLifterStatus() {
    let status = await redisClient.hGetAll(LIFTER_STATUS_KEY);

    // --- NEW: Physical Verification ---
    // If status is IDLE, verify with actual PLC sensors to ensure Redis isn't out of sync
    if (status && status.status !== 'MOVING') {
      try {
        const plcManager = require('../PLC/plcManager');
        const posF1 = plcManager.getValue('PLC_1', 'LIFTER_1_POS_F1');
        const posF2 = plcManager.getValue('PLC_1', 'LIFTER_1_POS_F2');

        const physicalFloor = posF1 ? 138 : posF2 ? 139 : null;

        if (physicalFloor && String(status.currentFloor) !== String(physicalFloor)) {
          logger.warn(
            `[LifterCoordination] Drift detected! Redis: F${status.currentFloor}, PLC: F${physicalFloor}. Correcting...`,
          );
          status.currentFloor = physicalFloor;
          await redisClient.hSet(LIFTER_STATUS_KEY, 'currentFloor', physicalFloor);
        }
      } catch (e) {
        logger.debug(`[LifterCoordination] Verify PLC failed (expected during startup): ${e.message}`);
      }
    }

    // If Redis is empty or missing critical fields, try to init from real state
    if (!status || !status.currentFloor) {
      try {
        // Direct Check via PLC Manager
        const plcManager = require('../PLC/plcManager');
        const posF1 = plcManager.getValue('PLC_1', 'LIFTER_1_POS_F1');
        const posF2 = plcManager.getValue('PLC_1', 'LIFTER_1_POS_F2');

        let detectedFloor = null;
        if (posF1) {
          detectedFloor = 138;
        } // Mapping logical F1 -> 138
        else if (posF2) {
          detectedFloor = 139;
        } // Mapping logical F2 -> 139

        if (detectedFloor) {
          status = {
            status: 'IDLE', // Assume IDLE if we just found it via sensor and no active move
            currentFloor: detectedFloor,
          };

          // Populate Redis so subsequent calls are fast
          await redisClient.hSet(LIFTER_STATUS_KEY, status);
          logger.info(`[LifterCoordination] Self-corrected Lifter Status from PLC: F${detectedFloor}`);
        } else {
          // Still unknown? Defaults to null, which is handled downstream
        }
      } catch (e) {
        logger.warn(`[LifterCoordination] Failed to init status: ${e.message}`);
      }
    }
    return status;
  }
}

module.exports = new LifterCoordinationService();
