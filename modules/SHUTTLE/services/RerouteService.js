const { logger } = require('../../../logger/logger');
const { findShortestPath } = require('./pathfinding');
const { publishToTopic } = require('../../../services/mqttClientService');
const redisClient = require('../../../redis/init.redis');
const PathCacheService = require('./PathCacheService');

class RerouteService {
  async calculateBackupReroute(shuttleId, conflict, currentNode, targetNode, floorId, options = {}) {
    try {
      const pathfindingOptions = {
        avoid: conflict ? [conflict.conflictNode] : [],
        isCarrying: options.isCarrying,
        trafficData: options.trafficData,
      };

      let backupPath = await findShortestPath(currentNode, targetNode, floorId, pathfindingOptions);

      if (backupPath) {
        const rerouteCostValidation = await this.validateRerouteCost(shuttleId, backupPath, options);
        if (rerouteCostValidation.acceptable) {
          return {
            type: 'REROUTE',
            path: backupPath,
            costIncrease: rerouteCostValidation.costIncrease,
            reason: 'Avoiding conflict node',
          };
        } else {
          if (options.emergency) {
            logger.warn(
              `[Reroute] Emergency reroute: backup path cost ${rerouteCostValidation.costIncrease}% (exceeds dynamic limit) but forced.`
            );
            return {
              type: 'EMERGENCY_REROUTE',
              path: backupPath,
              costIncrease: rerouteCostValidation.costIncrease,
              reason: 'Emergency reroute due to long waiting time',
            };
          } else {
            logger.warn(
              `[Reroute] Backup path cost too high (${rerouteCostValidation.costIncrease}% > ${rerouteCostValidation.maxAcceptablePercentage}%)`
            );
          }
        }
      }

      if (!backupPath) {
        logger.warn(
          `[Reroute] Strategy 1 (explicit conflict node avoidance) failed for shuttle ${shuttleId}. Trying dynamic avoidance.`
        );
        backupPath = await findShortestPath(currentNode, targetNode, floorId, {
          isCarrying: options.isCarrying,
          trafficData: options.trafficData,
        });

        if (backupPath) {
          const rerouteCostValidation = await this.validateRerouteCost(shuttleId, backupPath, options);
          if (rerouteCostValidation.acceptable) {
            return {
              type: 'REROUTE',
              path: backupPath,
              costIncrease: rerouteCostValidation.costIncrease,
              reason: 'Dynamic conflict avoidance',
            };
          } else {
            if (options.emergency) {
              logger.warn(
                `[Reroute] Emergency reroute: backup path cost ${rerouteCostValidation.costIncrease}% (exceeds dynamic limit) but forced.`
              );
              return {
                type: 'EMERGENCY_REROUTE',
                path: backupPath,
                costIncrease: rerouteCostValidation.costIncrease,
                reason: 'Emergency reroute due to long waiting time (dynamic avoidance)',
              };
            } else {
              logger.warn(
                `[Reroute] Backup path via dynamic avoidance cost too high (${rerouteCostValidation.costIncrease}% > ${rerouteCostValidation.maxAcceptablePercentage}%)`
              );
            }
          }
        }
      }

      logger.error(`[Reroute] No backup path found from ${currentNode} to ${targetNode} even with dynamic avoidance.`);
      return null;
    } catch (error) {
      logger.error(`[Reroute] Error calculating backup reroute:`, error);
      return null;
    }
  }

  async validateRerouteCost(shuttleId, newPath, options = {}) {
    try {
      if (options.emergency) {
        return { acceptable: true, reason: 'Emergency timeout - accepting any path', tier: 'EMERGENCY' };
      }

      const originalPath = await PathCacheService.getPath(shuttleId);
      let originalLength = 0;
      if (originalPath && originalPath.totalStep) {
        originalLength = originalPath.totalStep;
      } else {
        logger.warn(`[Reroute] Original path not found in cache for ${shuttleId}. Using new path as baseline.`);
        originalLength = newPath.totalStep || 1;
      }

      const newLength = newPath.totalStep || 0;
      const costIncrease =
        originalLength > 0 ? ((newLength - originalLength) / originalLength) * 100 : newLength > 0 ? 100 : 0;

      let maxAcceptablePercentage = 0;
      let tier = '';

      if (options.isCarrying) {
        maxAcceptablePercentage = 140;
        tier = 'TIER1_CARRYING';
      } else {
        maxAcceptablePercentage = 200;
        tier = 'TIER1_EMPTY';
      }

      const retryCount = options.retryCount || 0;
      if (retryCount > 0) {
        const retryBonus = retryCount * 50;
        maxAcceptablePercentage += retryBonus;
        tier = `TIER2_RETRY${retryCount}`;
        logger.debug(`[Reroute] Retry bonus: +${retryBonus}% (retry #${retryCount})`);
      }

      if (options.waitingTime > 0) {
        const waitingSeconds = options.waitingTime / 1000;

        const timeBonus = Math.floor(waitingSeconds / 15) * 50;
        maxAcceptablePercentage += timeBonus;

        if (waitingSeconds >= 45 && !options.emergency) {
          logger.warn(`[Reroute][Pillar3] Shuttle ${shuttleId} waited ${waitingSeconds}s - triggering TIER3_EMERGENCY`);
          tier = 'TIER3_EMERGENCY';
          maxAcceptablePercentage = 999;
        } else {
          tier = tier + `_WAIT${Math.floor(waitingSeconds)}s`;
        }

        logger.debug(`[Reroute][Pillar3] Waiting time bonus: +${timeBonus}% (waiting ${waitingSeconds}s)`);
      }

      if (tier !== 'TIER3_EMERGENCY' && tier !== 'EMERGENCY') {
        maxAcceptablePercentage = Math.min(maxAcceptablePercentage, 500);
      }

      const acceptable = costIncrease <= maxAcceptablePercentage;

      logger.info(
        `[Reroute][Pillar3] ${shuttleId} cost validation [${tier}]: original=${originalLength}, new=${newLength}, increase=${costIncrease.toFixed(2)}%, limit=${maxAcceptablePercentage}%, acceptable=${acceptable}`
      );

      return {
        acceptable,
        originalLength,
        newLength,
        costIncrease: parseFloat(costIncrease.toFixed(2)),
        maxAcceptablePercentage,
        tier,
      };
    } catch (error) {
      logger.error(`[Reroute] Error validating reroute cost:`, error);
      return {
        acceptable: false,
        error: error.message,
      };
    }
  }

  /**
   * Apply backup path to shuttle.
   *
   * @param {string} shuttleId - ID of shuttle
   * @param {object} backupPath - Backup path object
   * @param {string} reason - Reason for reroute
   * @returns {Promise<boolean>} Success status
   */
  async applyBackupPath(shuttleId, backupPath, reason = 'Timeout waiting for conflict resolution') {
    try {
      logger.info(`[Reroute] Applying backup path to shuttle ${shuttleId}`);

      // Send reroute command via MQTT
      const commandTopic = `shuttle/handle/${shuttleId}`;
      const commandPayload = {
        action: 'REROUTE',
        path: backupPath,
        reason,
        onArrival: 'REROUTE_COMPLETE',
      };

      publishToTopic(commandTopic, commandPayload);
      await PathCacheService.savePath(shuttleId, backupPath);
      await redisClient.set(`shuttle:${shuttleId}:status`, 'REROUTING', { EX: 300 });
      await redisClient.set(`shuttle:${shuttleId}:backup_path`, JSON.stringify(backupPath), { EX: 300 });

      await redisClient.incr('stats:reroutes:total');

      logger.info(`[Reroute] Reroute command sent to shuttle ${shuttleId}`);
      return true;
    } catch (error) {
      logger.error(`[Reroute] Error applying backup path:`, error);
      return false;
    }
  }

  async clearBackupPath(shuttleId) {
    try {
      await redisClient.del(`shuttle:${shuttleId}:backup_path`);
      logger.debug(`[Reroute] Cleared backup path for ${shuttleId}`);
      return true;
    } catch (error) {
      logger.error(`[Reroute] Error clearing backup path:`, error);
      return false;
    }
  }

  async getBackupPath(shuttleId) {
    try {
      const backupPathJson = await redisClient.get(`shuttle:${shuttleId}:backup_path`);
      if (!backupPathJson) {
        return null;
      }

      return JSON.parse(backupPathJson);
    } catch (error) {
      logger.error(`[Reroute] Error getting backup path:`, error);
      return null;
    }
  }

  async calculateBackupInBackground(shuttleId, conflict, currentNode, targetNode, floorId, options = {}) {
    try {
      logger.info(`[Reroute] Starting background backup calculation for shuttle ${shuttleId}`);

      const backup = await this.calculateBackupReroute(shuttleId, conflict, currentNode, targetNode, floorId, options);

      if (backup) {
        await redisClient.set(`shuttle:${shuttleId}:backup_path`, JSON.stringify(backup.path), { EX: 300 });
        logger.info(`[Reroute] Background backup calculation complete for ${shuttleId}`);
      } else {
        logger.warn(`[Reroute] Background backup calculation failed for ${shuttleId}`);
      }
    } catch (error) {
      logger.error(`[Reroute] Error in background backup calculation:`, error);
    }
  }
}

module.exports = new RerouteService();
