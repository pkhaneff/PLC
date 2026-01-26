const lifterService = require('../modules/Lifter/lifterService');
const lifterQueueService = require('../modules/Lifter/lifterQueueService');
const { logger } = require('../logger/logger');

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

      // Đăng ký task vào hàng đợi
      const result = await lifterService.requestLifterForTask(fromFloor, toFloor, lifterId, taskData);

      return res.status(200).json({
        success: true,
        message: 'Task registered successfully',
        data: result,
      });
    } catch (error) {
      console.error('Error in requestTask:', error);
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
      console.error('Error in getNextTask:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Bắt đầu xử lý một task
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
      console.error('Error in startTask:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Hoàn thành một task
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
      console.error('Error in completeTask:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Lấy thống kê hàng đợi
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
      console.error('Error in getQueueStats:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Lấy hàng đợi của một tầng cụ thể
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
      console.error('Error in getFloorQueue:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Lấy hàng đợi tổng
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
      console.error('Error in getGlobalQueue:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Lấy chi tiết một task
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
      console.error('Error in getTaskDetails:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Xóa toàn bộ hàng đợi (dùng cho testing)
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
      console.error('Error in clearQueues:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  /**
   * Lấy thông tin lifter theo ID
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
      console.error('Error in getLifterInfo:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  }

  // async simulateControl(req, res) {
  //   try {
  //     const { targetFloor } = req.body;
  //     const result = await lifterService.moveLifterToFloor(targetFloor);

  //     return res.status(200).json(result);
  //   } catch (error) {
  //     console.error('Error in simulateControl:', error);
  //     return res.status(500).json({
  //       success: false,
  //       message: error.message || 'Lỗi hệ thống'
  //     });
  //   }
  // }
}

module.exports = new LifterController();
