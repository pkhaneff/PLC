const lifterService = require('../modules/Lifter/lifterService');
const lifterQueueService = require('../modules/Lifter/lifterQueueService');
const { logger } = require('../logger/logger');

class LifterController {
  /**
   * Đăng ký yêu cầu sử dụng lifter cho nhiệm vụ
   * POST /api/v1/lifter/request-task
   * Body: {
   *   fromFloor: number,
   *   toFloor: number,
   *   lifterId: number,
   *   shuttleId?: string,
   *   orderId?: string,
   *   ...otherData
   * }
   */
  async requestTask(req, res) {
    try {
      const { fromFloor, toFloor, lifterId, ...taskData } = req.body;

      // Validate input
      if (!fromFloor || !toFloor || !lifterId) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: fromFloor, toFloor, lifterId'
        });
      }

      // Đăng ký task vào hàng đợi
      const result = await lifterService.requestLifterForTask(
        fromFloor,
        toFloor,
        lifterId,
        taskData
      );

      return res.status(200).json({
        success: true,
        message: 'Task registered successfully',
        data: result
      });
    } catch (error) {
      console.error('Error in requestTask:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
      });
    }
  }

  /**
   * Lấy task tiếp theo cần xử lý
   * GET /api/v1/lifter/next-task
   */
  async getNextTask(req, res) {
    try {
      const nextTask = await lifterService.getNextTaskFromQueue();

      if (!nextTask) {
        return res.status(200).json({
          success: true,
          message: 'No tasks in queue',
          data: null
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Next task retrieved successfully',
        data: nextTask
      });
    } catch (error) {
      console.error('Error in getNextTask:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
          message: 'Missing taskId parameter'
        });
      }

      const success = await lifterService.startProcessingTask(taskId);

      return res.status(200).json({
        success: success,
        message: success ? 'Task marked as processing' : 'Failed to mark task',
        data: { taskId }
      });
    } catch (error) {
      console.error('Error in startTask:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
          message: 'Missing taskId parameter'
        });
      }

      const result = await lifterService.completeTaskAndGetNext(taskId);

      return res.status(200).json({
        success: true,
        message: 'Task completed successfully',
        data: result
      });
    } catch (error) {
      console.error('Error in completeTask:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
        data: stats
      });
    } catch (error) {
      console.error('Error in getQueueStats:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
          message: 'Missing floorId parameter'
        });
      }

      const tasks = await lifterService.getFloorQueueTasks(parseInt(floorId));

      return res.status(200).json({
        success: true,
        message: 'Floor queue retrieved successfully',
        data: {
          floorId: parseInt(floorId),
          queueLength: tasks.length,
          tasks: tasks
        }
      });
    } catch (error) {
      console.error('Error in getFloorQueue:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
          tasks: tasks
        }
      });
    } catch (error) {
      console.error('Error in getGlobalQueue:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
          message: 'Missing taskId parameter'
        });
      }

      const taskDetails = await lifterQueueService.getTaskDetails(taskId);

      if (!taskDetails) {
        return res.status(404).json({
          success: false,
          message: 'Task not found'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Task details retrieved successfully',
        data: taskDetails
      });
    } catch (error) {
      console.error('Error in getTaskDetails:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
        message: success ? 'All queues cleared successfully' : 'Failed to clear queues'
      });
    } catch (error) {
      console.error('Error in clearQueues:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
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
          message: 'Missing lifterId parameter'
        });
      }

      const lifter = await lifterService.getLifterById(parseInt(lifterId));

      if (!lifter) {
        return res.status(404).json({
          success: false,
          message: 'Lifter not found'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Lifter info retrieved successfully',
        data: lifter
      });
    } catch (error) {
      console.error('Error in getLifterInfo:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
      });
    }
  }
  /**
   * Mô phỏng điều khiển và giám sát lifter
   * POST /api/v1/lifter/simulate-control
   * Body: { targetFloor: number }
   */
  async simulateControl(req, res) {
    try {
      const { targetFloor } = req.body;
      const plcId = 'PLC_1'; // Mặc định dùng PLC_1 cho mô phỏng

      if (targetFloor !== 1 && targetFloor !== 2) {
        return res.status(400).json({
          success: false,
          message: 'Tầng mục tiêu phải là 1 hoặc 2'
        });
      }

      const plcManager = require('../modules/PLC/plcManager');

      // 1. Đọc vị trí hiện tại
      const posF1 = plcManager.getValue(plcId, 'LIFTER_1_POS_F1');
      const posF2 = plcManager.getValue(plcId, 'LIFTER_1_POS_F2');
      const currentFloor = posF1 ? 1 : (posF2 ? 2 : 0);

      if (currentFloor === targetFloor) {
        return res.json({
          success: true,
          message: `Lifter đã ở tầng ${targetFloor}`,
          data: { currentFloor }
        });
      }

      // 2. Ghi lệnh điều khiển di chuyển
      const ctrlTag = targetFloor === 1 ? 'LIFTER_1_CTRL_F1' : 'LIFTER_1_CTRL_F2';
      const writeResult = await plcManager.writeValue(plcId, ctrlTag, true);

      if (writeResult?.error) {
        throw new Error(`Không thể ghi lệnh điều khiển xuống PLC: ${writeResult.error}`);
      }

      // 3. Giám sát lỗi và di chuyển (mô phỏng)
      let moveTime = 0;
      const maxMoveTime = 2000;
      const checkInterval = 500;

      const monitorMovement = () => new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          moveTime += checkInterval;

          // Kiểm tra lỗi
          const hasError = plcManager.getValue(plcId, 'LIFTER_1_ERROR');
          if (hasError) {
            clearInterval(timer);
            return reject(new Error('Lifter gặp lỗi trong quá trình di chuyển!'));
          }

          logger.debug(`[LifterSim] Đang di chuyển... (${moveTime}ms)`);

          if (moveTime >= maxMoveTime) {
            clearInterval(timer);
            resolve();
          }
        }, checkInterval);
      });

      try {
        await monitorMovement();
      } catch (error) {
        return res.status(500).json({
          success: false,
          message: error.message
        });
      }

      // 4. Khi đến nơi, cập nhật vị trí
      const targetPosTag = targetFloor === 1 ? 'LIFTER_1_POS_F1' : 'LIFTER_1_POS_F2';
      const oldPosTag = targetFloor === 1 ? 'LIFTER_1_POS_F2' : 'LIFTER_1_POS_F1';

      await plcManager.writeValue(plcId, targetPosTag, true);
      await plcManager.writeValue(plcId, oldPosTag, false);
      await plcManager.writeValue(plcId, ctrlTag, false); // Tắt lệnh điều khiển

      logger.info(`[LifterSim] Đã đến tầng ${targetFloor}. Cập nhật sensor.`);

      return res.json({
        success: true,
        message: `Đã di chuyển lifter tới tầng ${targetFloor} thành công`,
        data: {
          previousFloor: currentFloor,
          currentFloor: targetFloor
        }
      });

    } catch (error) {
      console.error('Error in simulateControl:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Lỗi hệ thống'
      });
    }
  }
}

module.exports = new LifterController();
