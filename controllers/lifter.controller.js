const lifterService = require('../modules/Lifter/lifterService');
const lifterQueueService = require('../modules/Lifter/lifterQueueService');
const { logger } = require('../config/logger');

class LifterController {
  async requestTask(req, res) {
    try {
      const { fromFloor, toFloor, lifterId, ...taskData } = req.body;

      // Validate input
      if (!fromFloor || !toFloor || !lifterId) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: fromFloor, toFloor, lifterId',
        });
      }

      // Register task into queue
      const result = await lifterService.requestLifterForTask(fromFloor, toFloor, lifterId, taskData);

      return res.status(200).json({
        success: true,
        message: 'Task registered successfully',
        data: result,
      });
    } catch (error) {
      logger.error(`Error in requestTask: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  async getNextTask(req, res) {
    try {
      const nextTask = await lifterService.getNextTaskFromQueue();

      if (!nextTask) {
        return res.status(200).json({
          success: true,
          message: 'No tasks in queue',
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Next task retrieved successfully',
        data: nextTask,
      });
    } catch (error) {
      logger.error(`Error in getNextTask: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Start processing a task.
   * POST /api/v1/lifter/start-task/:taskId
   */
  async startTask(req, res) {
    try {
      const { taskId } = req.params;

      if (!taskId) {
        return res.status(400).json({
          success: false,
          message: 'Missing taskId parameter',
        });
      }

      const success = await lifterService.startProcessingTask(taskId);

      return res.status(200).json({
        success: success,
        message: success ? 'Task marked as processing' : 'Failed to mark task',
        data: { taskId },
      });
    } catch (error) {
      logger.error(`Error in startTask: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Complete a task.
   * POST /api/v1/lifter/complete-task/:taskId
   */
  async completeTask(req, res) {
    try {
      const { taskId } = req.params;

      if (!taskId) {
        return res.status(400).json({
          success: false,
          message: 'Missing taskId parameter',
        });
      }

      const result = await lifterService.completeTaskAndGetNext(taskId);

      return res.status(200).json({
        success: true,
        message: 'Task completed successfully',
        data: result,
      });
    } catch (error) {
      logger.error(`Error in completeTask: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Get queue statistics.
   * GET /api/v1/lifter/queue-stats
   */
  async getQueueStats(req, res) {
    try {
      const stats = await lifterService.getQueueStatistics();

      return res.status(200).json({
        success: true,
        message: 'Queue statistics retrieved successfully',
        data: stats,
      });
    } catch (error) {
      logger.error(`Error in getQueueStats: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Get queue for a specific floor.
   * GET /api/v1/lifter/floor-queue/:floorId
   */
  async getFloorQueue(req, res) {
    try {
      const { floorId } = req.params;

      if (!floorId) {
        return res.status(400).json({
          success: false,
          message: 'Missing floorId parameter',
        });
      }

      const tasks = await lifterService.getFloorQueueTasks(parseInt(floorId));

      return res.status(200).json({
        success: true,
        message: 'Floor queue retrieved successfully',
        data: {
          floorId: parseInt(floorId),
          queueLength: tasks.length,
          tasks: tasks,
        },
      });
    } catch (error) {
      logger.error(`Error in getFloorQueue: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Get global queue.
   * GET /api/v1/lifter/global-queue?limit=10
   */
  async getGlobalQueue(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const tasks = await lifterService.getGlobalQueueTasks(limit);

      return res.status(200).json({
        success: true,
        message: 'Global queue retrieved successfully',
        data: {
          queueLength: tasks.length,
          tasks: tasks,
        },
      });
    } catch (error) {
      logger.error(`Error in getGlobalQueue: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Get details of a task.
   * GET /api/v1/lifter/task/:taskId
   */
  async getTaskDetails(req, res) {
    try {
      const { taskId } = req.params;

      if (!taskId) {
        return res.status(400).json({
          success: false,
          message: 'Missing taskId parameter',
        });
      }

      const taskDetails = await lifterQueueService.getTaskDetails(taskId);

      if (!taskDetails) {
        return res.status(404).json({
          success: false,
          message: 'Task not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Task details retrieved successfully',
        data: taskDetails,
      });
    } catch (error) {
      logger.error(`Error in getTaskDetails: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Clear all queues (used for testing).
   * DELETE /api/v1/lifter/clear-queues
   */
  async clearQueues(req, res) {
    try {
      const success = await lifterService.clearAllQueues();

      return res.status(200).json({
        success: success,
        message: success ? 'All queues cleared successfully' : 'Failed to clear queues',
      });
    } catch (error) {
      logger.error(`Error in clearQueues: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Get lifter information by ID.
   * GET /api/v1/lifter/info/:lifterId
   */
  async getLifterInfo(req, res) {
    try {
      const { lifterId } = req.params;

      if (!lifterId) {
        return res.status(400).json({
          success: false,
          message: 'Missing lifterId parameter',
        });
      }

      const lifter = await lifterService.getLifterById(parseInt(lifterId));

      if (!lifter) {
        return res.status(404).json({
          success: false,
          message: 'Lifter not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Lifter info retrieved successfully',
        data: lifter,
      });
    } catch (error) {
      logger.error(`Error in getLifterInfo: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }
}

module.exports = new LifterController();
