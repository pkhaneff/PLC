const { logger } = require('../../../logger/logger');
const PriorityCalculationService = require('./PriorityCalculationService');
const ParkingNodeService = require('./ParkingNodeService');
const BacktrackService = require('./BacktrackService');
const RerouteService = require('./RerouteService');
const { getShuttleState } = require('./shuttleStateCache');
const redisClient = require('../../../redis/init.redis');
const PathCacheService = require('./PathCacheService');

class ConflictResolutionService {
  async handleConflict(shuttleId, event) {
    try {
      const { waitingAt, targetNode, blockedBy } = event;

      const conflict = {
        shuttleId,
        currentNode: waitingAt,
        conflictNode: targetNode,
        blockedBy,
      };

      const shuttleState = await getShuttleState(shuttleId);
      if (!shuttleState) {
        logger.error(`[ConflictResolution] Shuttle ${shuttleId} state not found`);
        return { success: false, reason: 'Shuttle state not found' };
      }

      // Get task info from Redis or state
      const taskInfo = await this.getTaskInfo(shuttleId);

      // Compare priorities if we know who is blocking
      if (blockedBy) {
        const blockerTaskInfo = await this.getTaskInfo(blockedBy);
        const comparison = await PriorityCalculationService.comparePriority(
          shuttleId,
          taskInfo,
          blockedBy,
          blockerTaskInfo
        );

        if (comparison.winner === shuttleId) {
          await this.requestYield(blockedBy, shuttleId, conflict);

          return {
            success: true,
            action: 'NO_YIELD',
            message: `Shuttle ${shuttleId} has higher priority, waiting for ${blockedBy} to clear`,
          };
        } else {
          return await this.handleYield(shuttleId, conflict, shuttleState);
        }
      } else {
        const potentialBlocker = await this.findShuttleAtNode(conflict.conflictNode);

        if (potentialBlocker && potentialBlocker !== shuttleId) {
          const blockerTaskInfo = await this.getTaskInfo(potentialBlocker);
          const comparison = await PriorityCalculationService.comparePriority(
            shuttleId,
            taskInfo,
            potentialBlocker,
            blockerTaskInfo
          );

          if (comparison.winner === shuttleId) {
            await this.requestYield(potentialBlocker, shuttleId, conflict);

            return {
              success: true,
              action: 'NO_YIELD',
              message: `Shuttle ${shuttleId} has higher priority, waiting for ${potentialBlocker} to clear`,
            };
          } else {
            return await this.handleYield(shuttleId, conflict, shuttleState);
          }
        } else {
          logger.warn(`[ConflictResolution] Cannot identify blocker for shuttle ${shuttleId}, waiting in place`);
          return await this.waitAtNode(
            shuttleId,
            conflict.currentNode,
            conflict,
            await this.getFloorId(conflict.currentNode)
          );
        }
      }
    } catch (error) {
      logger.error(`[ConflictResolution] Error handling conflict:`, error);
      return { success: false, error: error.message };
    }
  }

  async handleYield(shuttleId, conflict, shuttleState) {
    try {
      const floorId = await this.getFloorId(shuttleState.qrCode);

      const parkingNode = await ParkingNodeService.findAvailableParkingNode({
        nearNode: conflict.currentNode,
        conflictNode: conflict.conflictNode,
        shuttleId,
        floorId,
      });

      if (parkingNode) {
        return await this.useParkingStrategy(shuttleId, parkingNode, conflict, floorId);
      }

      // Strategy 2: Try backtrack
      return await this.useBacktrackStrategy(shuttleId, conflict, floorId);
    } catch (error) {
      logger.error(`[ConflictResolution] Error in yield strategy:`, error);
      return { success: false, error: error.message };
    }
  }

  async useParkingStrategy(shuttleId, parkingNode, conflict, floorId) {
    try {
      const validation = await ParkingNodeService.validatePathToParking(
        conflict.currentNode,
        parkingNode,
        shuttleId,
        floorId
      );

      if (!validation.isValid) {
        logger.warn(`[ConflictResolution] Path to parking invalid: ${validation.reason}`);
        return await this.useBacktrackStrategy(shuttleId, conflict, floorId);
      }

      const { findShortestPath } = require('./pathfinding');
      const pathToParking = await findShortestPath(conflict.currentNode, parkingNode, floorId);

      if (!pathToParking) {
        logger.error(`[ConflictResolution] Cannot find path to parking ${parkingNode}`);
        return await this.useBacktrackStrategy(shuttleId, conflict, floorId);
      }

      const mqttService = require('../../../services/mqttClientService');
      const commandTopic = `shuttle/handle/${shuttleId}`;
      const commandPayload = {
        action: 'MOVE_TO_PARKING',
        path: pathToParking,
        destination: parkingNode,
        reason: 'Yielding to higher priority shuttle',
        onArrival: 'PARKING_COMPLETE',
      };

      mqttService.publishToTopic(commandTopic, commandPayload);

      // Update shuttle status
      await redisClient.set(`shuttle:${shuttleId}:status`, 'MOVING_TO_PARKING', { EX: 300 });
      await redisClient.set(`shuttle:${shuttleId}:parking_node`, parkingNode, { EX: 300 });

      // Start monitoring and backup calculation
      await this.waitAtNode(shuttleId, parkingNode, conflict, floorId);

      // Increment stats
      await redisClient.incr('stats:conflicts:parking_used');

      return {
        success: true,
        strategy: 'PARKING',
        parkingNode,
        message: `Shuttle ${shuttleId} moving to parking ${parkingNode}`,
      };
    } catch (error) {
      logger.error(`[ConflictResolution] Error in parking strategy:`, error);
      return { success: false, error: error.message };
    }
  }

  async useBacktrackStrategy(shuttleId, conflict, floorId) {
    try {
      const backtrackResult = await BacktrackService.findSafeBacktrackNode(shuttleId, conflict, floorId);

      if (!backtrackResult) {
        logger.error(`[ConflictResolution] No safe backtrack node found for ${shuttleId}`);
        return await this.waitAtNode(shuttleId, conflict.currentNode, conflict, floorId);
      }

      if (backtrackResult.action === 'BACKTRACK_TO_PARKING') {
        const backtracked = await BacktrackService.backtrackToNode(
          shuttleId,
          backtrackResult.backtrackNode,
          backtrackResult.backtrackSteps,
          floorId
        );

        if (!backtracked) {
          logger.error(`[ConflictResolution] Backtrack failed for ${shuttleId}`);
          return { success: false, strategy: 'BACKTRACK_FAILED' };
        }

        // Store next action - shuttle will move to parking after arriving at backtrack node
        await redisClient.set(`shuttle:${shuttleId}:next_action`, 'MOVE_TO_PARKING', { EX: 300 });
        await redisClient.set(`shuttle:${shuttleId}:parking_target`, backtrackResult.parkingNode, { EX: 300 });

        // Increment stats
        await redisClient.incr('stats:conflicts:backtrack_used');

        return {
          success: true,
          strategy: 'BACKTRACK_THEN_PARKING',
          backtrackNode: backtrackResult.backtrackNode,
          backtrackSteps: backtrackResult.backtrackSteps,
          parkingNode: backtrackResult.parkingNode,
          message: `Shuttle ${shuttleId} backtracking ${backtrackResult.backtrackSteps} steps, then moving to parking`,
        };
      } else {
        // Backtrack and wait at that position
        const backtracked = await BacktrackService.backtrackToNode(
          shuttleId,
          backtrackResult.backtrackNode,
          backtrackResult.backtrackSteps,
          floorId
        );

        if (!backtracked) {
          logger.error(`[ConflictResolution] Backtrack failed for ${shuttleId}`);
          return { success: false, strategy: 'BACKTRACK_FAILED' };
        }

        // Store waiting info
        await redisClient.set(`shuttle:${shuttleId}:next_action`, 'WAIT', { EX: 300 });
        await redisClient.set(`shuttle:${shuttleId}:status`, 'BACKTRACKING', { EX: 300 });

        // Increment stats
        await redisClient.incr('stats:conflicts:backtrack_used');

        return {
          success: true,
          strategy: 'BACKTRACK_AND_WAIT',
          backtrackNode: backtrackResult.backtrackNode,
          backtrackSteps: backtrackResult.backtrackSteps,
          message: `Shuttle ${shuttleId} backtracked ${backtrackResult.backtrackSteps} steps and will wait`,
        };
      }
    } catch (error) {
      logger.error(`[ConflictResolution] Error in backtrack strategy:`, error);
      return { success: false, error: error.message };
    }
  }

  async waitAtNode(shuttleId, waitNode, conflict, floorId) {
    try {
      const waitingSince = Date.now();
      await redisClient.set(`shuttle:${shuttleId}:waiting_since`, waitingSince.toString(), { EX: 300 });
      await redisClient.set(`shuttle:${shuttleId}:status`, 'WAITING', { EX: 300 });

      const taskInfo = await this.getTaskInfo(shuttleId);
      const targetNode = taskInfo?.endNodeQr || taskInfo?.pickupNodeQr;
      const shuttleState = await getShuttleState(shuttleId);

      if (targetNode) {
        const trafficData = await PathCacheService.getAllActivePaths();

        RerouteService.calculateBackupInBackground(shuttleId, conflict, waitNode, targetNode, floorId, {
          isCarrying: shuttleState?.isCarrying || false,
          waitingTime: 0,
          emergency: false,
          trafficData: trafficData,
        }).catch((err) => {
          logger.error(`[ConflictResolution] Background backup calculation error:`, err);
        });
      }

      const initialRetryDelay = 5000;
      setTimeout(async () => {
        await this.handleWaitTimeout(shuttleId, conflict, floorId, 0);
      }, initialRetryDelay);
    } catch (error) {
      logger.error(`[ConflictResolution] Error in wait at node:`, error);
    }
  }

  async handleWaitTimeout(shuttleId, conflict, floorId, retryCount) {
    try {
      const status = await redisClient.get(`shuttle:${shuttleId}:status`);
      if (status !== 'WAITING') {
        return;
      }

      logger.warn(`[ConflictResolution] Wait timeout for shuttle ${shuttleId}, attempt ${retryCount + 1}`);

      const waitingSince = await redisClient.get(`shuttle:${shuttleId}:waiting_since`);
      const currentTime = Date.now();
      const waitingTime = waitingSince ? currentTime - parseInt(waitingSince, 10) : 0;

      const taskInfo = await this.getTaskInfo(shuttleId);
      const shuttleState = await getShuttleState(shuttleId);

      // Get traffic data for reroute calculation
      const trafficData = await PathCacheService.getAllActivePaths();

      let rerouteOptions = {
        isCarrying: shuttleState?.isCarrying || false,
        waitingTime: waitingTime,
        trafficData: trafficData,
        emergency: false,
      };

      const EMERGENCY_TIMEOUT = 45000;
      if (waitingTime >= EMERGENCY_TIMEOUT) {
        rerouteOptions.emergency = true;
        logger.warn(
          `[ConflictResolution] Shuttle ${shuttleId} waiting for ${waitingTime}ms. Activating emergency reroute!`
        );
      }

      const currentPath = await PathCacheService.getPath(shuttleId);
      const targetNode = currentPath?.path?.meta?.endNodeQr || taskInfo?.endNodeQr || taskInfo?.pickupNodeQr;
      const currentNode = shuttleState?.qrCode;

      if (!targetNode || !currentNode) {
        logger.error(`[ConflictResolution] Cannot determine target or current node for reroute of ${shuttleId}.`);
        await redisClient.del(`shuttle:${shuttleId}:waiting_since`);
        return;
      }

      const rerouteResult = await RerouteService.calculateBackupReroute(
        shuttleId,
        conflict,
        currentNode,
        targetNode,
        floorId,
        rerouteOptions
      );

      if (rerouteResult && rerouteResult.path) {
        await RerouteService.applyBackupPath(shuttleId, rerouteResult.path, `Wait timeout - attempt ${retryCount + 1}`);
        await redisClient.del(`shuttle:${shuttleId}:waiting_since`);
        return;
      } else {
        logger.warn(
          `[ConflictResolution] No suitable reroute found for ${shuttleId} after ${waitingTime}ms wait (attempt ${retryCount + 1}).`
        );

        const MAX_RETRIES = 5;
        const RETRY_INTERVAL_MS = 10000;

        if (retryCount < MAX_RETRIES && waitingTime < EMERGENCY_TIMEOUT) {
          const nextRetryDelay = RETRY_INTERVAL_MS;
          setTimeout(async () => {
            await this.handleWaitTimeout(shuttleId, conflict, floorId, retryCount + 1);
          }, nextRetryDelay);
        } else {
          logger.error(
            `[ConflictResolution] Max reroute retries reached or emergency timeout for ${shuttleId}. Escalating.`
          );
          await redisClient.del(`shuttle:${shuttleId}:waiting_since`);
        }
      }
    } catch (error) {
      logger.error(`[ConflictResolution] Error handling wait timeout for ${shuttleId}:`, error);
    }
  }

  async requestYield(targetShuttleId, requesterId, conflict) {
    try {
      const { getShuttleState } = require('./shuttleStateCache');
      const targetState = await getShuttleState(targetShuttleId);

      if (!targetState) {
        logger.error(`[ConflictResolution] Cannot request yield: shuttle ${targetShuttleId} state not found`);
        return { success: false, reason: 'Target shuttle state not found' };
      }

      const floorId = await this.getFloorId(targetState.qrCode);

      const yieldResult = await this.handleYield(targetShuttleId, conflict, targetState);

      return {
        success: true,
        action: 'YIELD_EXECUTED',
        targetShuttle: targetShuttleId,
        yieldStrategy: yieldResult.strategy,
        yieldResult: yieldResult,
      };
    } catch (error) {
      logger.error(`[ConflictResolution] Error requesting yield:`, error);
      return { success: false, error: error.message };
    }
  }

  async getTaskInfo(shuttleId) {
    try {
      const taskInfoJson = await redisClient.get(`shuttle:${shuttleId}:task_info`);
      if (taskInfoJson) {
        return JSON.parse(taskInfoJson);
      }

      const shuttleState = await getShuttleState(shuttleId);
      if (shuttleState && shuttleState.taskId) {
        const shuttleTaskQueueService = require('./shuttleTaskQueueService');
        const taskDetail = await shuttleTaskQueueService.getTaskDetails(shuttleState.taskId);
        if (taskDetail) return taskDetail;
      }

      return {
        taskId: 0,
        isCarrying: false,
      };
    } catch (error) {
      logger.error(`[ConflictResolution] Error getting task info:`, error);
      return { taskId: 0, isCarrying: false };
    }
  }

  async getFloorId(qrCode) {
    try {
      const cellService = require('./cellService');
      const cells = await cellService.getCellByQrCodeAnyFloor(qrCode);

      if (cells && cells.length > 0) {
        const floorId = cells[0].floor_id;
        logger.debug(`[ConflictResolution] Resolved QR ${qrCode} to floor ID ${floorId}`);
        return floorId;
      }

      logger.warn(`[ConflictResolution] Could not find floor ID for QR ${qrCode}, defaulting to floor 1`);
      return 1;
    } catch (error) {
      logger.error(`[ConflictResolution] Error getting floor ID for QR ${qrCode}:`, error);
      return 1;
    }
  }

  async findShuttleAtNode(nodeQr) {
    try {
      const key = `node:${nodeQr}:occupied_by`;
      const occupier = await redisClient.get(key);
      if (occupier) {
        return occupier;
      }

      const allShuttles = await require('./shuttleStateCache').getAllShuttleStates();
      const shuttleAtNode = allShuttles.find((s) => s.qrCode === nodeQr);
      return shuttleAtNode ? shuttleAtNode.no : null;
    } catch (error) {
      logger.error(`[ConflictResolution] Error finding shuttle at node ${nodeQr}:`, error);
      return null;
    }
  }
}

module.exports = new ConflictResolutionService();
