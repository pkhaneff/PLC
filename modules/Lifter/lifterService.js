const lifterQueueService = require('./lifterQueueService');
const plcManager = require('../PLC/plcManager');
const { logger } = require('../../config/logger');

/**
 * LifterService - Refactored to use Dependency Injection
 * Tuân thủ Dependency Inversion Principle
 */
class LifterService {
  /**
   * @param {Object} dbConnection - Database connection instance (injected)
   */
  constructor(dbConnection) {
    this.db = dbConnection;
  }
  /**
   * Lấy lifter cell trên một tầng cụ thể
   * Mỗi lifter có nhiều cells trên các tầng khác nhau nhưng cùng vị trí (col, row)
   * @param {number} floorId - ID của tầng
   * @returns {Object|null} Lifter cell object: { name, col, row, floor_id, qr_code, cell_id }
   */
  async getLifterCellOnFloor(floorId) {
    try {
      const query = `
        SELECT c.id as cell_id, c.name, c.col, c.\`row\`, c.floor_id, c.qr_code, c.is_block,
               c.direction_type, c.cell_type, lc.lifter_id
        FROM lifter_cells lc
        JOIN cells c ON c.id = lc.cell_id
        WHERE c.floor_id = ? AND (c.is_block = 0 OR c.is_block IS NULL)
        LIMIT 1
      `;

      const [rows] = await this.db.execute(query, [floorId]);
      return rows[0] || null;
    } catch (error) {
      console.error('Error fetching lifter cell on floor:', error);
      throw error;
    }
  }

  /**
   * Chuyển đổi ID tầng từ Database sang chỉ số tầng của Lifter (1 hoặc 2)
   */
  mapFloorIdToLifterIndex(floorId) {
    // THACO logic: 138 -> 1 (Tầng 1), 139 -> 2 (Tầng 2)
    if (floorId == 138) {
      return 1;
    }
    if (floorId == 139) {
      return 2;
    }
    // Nếu truyền thẳng 1 hoặc 2 (legacy)
    if (floorId == 1 || floorId == 2) {
      return floorId;
    }
    return null;
  }

  /**
   * Lấy tất cả lifter cells trên một tầng (nếu có nhiều lifters)
   * @param {number} floorId - ID của tầng
   * @returns {Array} Mảng lifter cells
   */
  async getAllLifterCellsOnFloor(floorId) {
    try {
      const query = `
        SELECT c.id as cell_id, c.name, c.col, c.\`row\`, c.floor_id, c.qr_code,
               c.is_block, c.direction_type, c.cell_type, lc.lifter_id
        FROM lifter_cells lc
        JOIN cells c ON c.id = lc.cell_id
        WHERE c.floor_id = ?
        ORDER BY c.col, c.\`row\`
      `;

      const [rows] = await this.db.execute(query, [floorId]);
      return rows;
    } catch (error) {
      console.error('Error fetching all lifter cells on floor:', error);
      throw error;
    }
  }

  /**
   * Kiểm tra xem một tầng có lifter không
   * @param {number} floorId - ID của tầng
   * @returns {boolean} true nếu có lifter, false nếu không
   */
  async hasLifterOnFloor(floorId) {
    const lifterCell = await this.getLifterCellOnFloor(floorId);
    return lifterCell !== null;
  }

  /**
   * Lấy tất cả lifters đang rảnh (status = 'idle' hoặc tương tự)
   * @returns {Array} Mảng lifters: [{ id, name, status, current_cell_id, ... }]
   */
  async getAvailableLifters() {
    try {
      const query = `
        SELECT id, name, status, current_cell_id, is_import_lifter, is_export_lifter
        FROM lifters
        WHERE status = 'idle' OR status = 'available'
        ORDER BY id
      `;

      const [rows] = await this.db.execute(query);
      return rows;
    } catch (error) {
      console.error('Error fetching available lifters:', error);
      throw error;
    }
  }

  /**
   * Lấy cells của một lifter cụ thể trên các tầng
   * @param {number} lifterId - ID của lifter
   * @param {Array<number>} floorIds - Mảng floor IDs cần lấy
   * @returns {Object} Object với key là floor_id, value là cell info
   * Ví dụ: { 138: { cell_id: 1405, name: 'A4', ... }, 139: { cell_id: 1406, name: 'A4', ... } }
   */
  async getLifterCellsByFloors(lifterId, floorIds) {
    try {
      const placeholders = floorIds.map(() => '?').join(',');
      const query = `
        SELECT c.id as cell_id, c.name, c.col, c.\`row\`, c.floor_id, c.qr_code, c.is_block,
               c.direction_type, c.cell_type, lc.lifter_id
        FROM lifter_cells lc
        JOIN cells c ON c.id = lc.cell_id
        WHERE lc.lifter_id = ? AND c.floor_id IN (${placeholders})
        ORDER BY c.floor_id
      `;

      const [rows] = await this.db.execute(query, [lifterId, ...floorIds]);

      // Convert array to object { floor_id: cell_info }
      const result = {};
      for (const row of rows) {
        result[row.floor_id] = row;
      }

      return result;
    } catch (error) {
      console.error('Error fetching lifter cells by floors:', error);
      throw error;
    }
  }

  /**
   * Lấy thông tin lifter theo ID (không cần tìm kiếm, chỉ lấy thông tin)
   * @param {number} lifterId - ID của lifter được chỉ định
   * @returns {Object|null} Lifter info
   */
  async getLifterById(lifterId) {
    try {
      const query = `
        SELECT id, name, status, current_cell_id, is_import_lifter, is_export_lifter
        FROM lifters
        WHERE id = ?
      `;

      const [rows] = await this.db.execute(query, [lifterId]);
      return rows[0] || null;
    } catch (error) {
      console.error('Error fetching lifter by ID:', error);
      throw error;
    }
  }

  /**
   * Kiểm tra lifter có sẵn để thực hiện nhiệm vụ không
   * @param {number} lifterId - ID của lifter
   * @returns {boolean} true nếu lifter sẵn sàng
   */
  async isLifterAvailable(lifterId) {
    try {
      const lifter = await this.getLifterById(lifterId);
      if (!lifter) {
        return false;
      }

      return lifter.status === 'idle' || lifter.status === 'available';
    } catch (error) {
      console.error('Error checking lifter availability:', error);
      return false;
    }
  }

  /**
   * Tạo yêu cầu sử dụng lifter cho nhiệm vụ khác tầng
   * @param {number} fromFloor - Tầng xuất phát
   * @param {number} toFloor - Tầng đích
   * @param {number} lifterId - ID của lifter được chỉ định
   * @param {Object} taskData - Dữ liệu bổ sung (shuttleId, orderId, etc.)
   * @returns {Object} { taskId, queueInfo }
   */
  async requestLifterForTask(fromFloor, toFloor, lifterId, taskData = {}) {
    try {
      // Kiểm tra lifter có tồn tại không
      const lifter = await this.getLifterById(lifterId);
      if (!lifter) {
        throw new Error(`Lifter ${lifterId} not found`);
      }

      // Kiểm tra lifter có cells trên cả 2 tầng không
      const cells = await this.getLifterCellsByFloors(lifterId, [fromFloor, toFloor]);
      if (!cells[fromFloor] || !cells[toFloor]) {
        throw new Error(`Lifter ${lifterId} does not have cells on both floors ${fromFloor} and ${toFloor}`);
      }

      // Kiểm tra cells không bị block
      if (cells[fromFloor].is_block === 1 || cells[toFloor].is_block === 1) {
        throw new Error(`Lifter ${lifterId} cells are blocked on one or both floors`);
      }

      // Đăng ký task vào hàng đợi Redis
      const queueInfo = await lifterQueueService.registerTask(fromFloor, toFloor, lifterId, {
        ...taskData,
        lifterName: lifter.name,
        fromCell: JSON.stringify(cells[fromFloor]),
        toCell: JSON.stringify(cells[toFloor]),
      });

      return {
        success: true,
        taskId: queueInfo.taskId,
        lifter: lifter,
        cells: cells,
        queueInfo: {
          positionInGlobalQueue: queueInfo.position,
          globalQueueLength: queueInfo.globalQueueLength,
          floorQueueLength: queueInfo.floorQueueLength,
          estimatedWaitTime: this.estimateWaitTime(queueInfo.position),
        },
      };
    } catch (error) {
      console.error('Error requesting lifter for task:', error);
      throw error;
    }
  }

  /**
   * Ước tính thời gian chờ dựa trên vị trí trong hàng đợi
   * @param {number} position - Vị trí trong hàng đợi
   * @returns {number} Thời gian chờ ước tính (giây)
   */
  estimateWaitTime(position) {
    // Giả sử mỗi task trung bình mất 60 giây
    const avgTaskDuration = 60;
    return (position - 1) * avgTaskDuration;
  }

  /**
   * Lấy task tiếp theo cần xử lý từ hàng đợi
   * @returns {Object|null} Task data
   */
  async getNextTaskFromQueue() {
    try {
      return await lifterQueueService.getNextTask();
    } catch (error) {
      console.error('Error getting next task from queue:', error);
      throw error;
    }
  }

  /**
   * Đánh dấu task đang được xử lý
   * @param {string} taskId - ID của task
   * @returns {boolean} Success
   */
  async startProcessingTask(taskId) {
    try {
      return await lifterQueueService.markTaskAsProcessing(taskId);
    } catch (error) {
      console.error('Error starting task processing:', error);
      throw error;
    }
  }

  /**
   * Hoàn thành một task và lấy task tiếp theo
   * @param {string} taskId - ID của task đã hoàn thành
   * @returns {Object} { success, nextTask, stats }
   */
  async completeTaskAndGetNext(taskId) {
    try {
      const result = await lifterQueueService.completeTask(taskId);
      return result;
    } catch (error) {
      console.error('Error completing task:', error);
      throw error;
    }
  }

  /**
   * Lấy thống kê hàng đợi
   * @returns {Object} Queue statistics
   */
  async getQueueStatistics() {
    try {
      return await lifterQueueService.getQueueStats();
    } catch (error) {
      console.error('Error getting queue statistics:', error);
      throw error;
    }
  }

  /**
   * Lấy danh sách tasks trong hàng đợi của một tầng
   * @param {number} floorId - ID của tầng
   * @returns {Array} Mảng tasks
   */
  async getFloorQueueTasks(floorId) {
    try {
      const taskIds = await lifterQueueService.getFloorQueue(floorId);
      const tasks = [];

      for (const taskId of taskIds) {
        const taskDetails = await lifterQueueService.getTaskDetails(taskId);
        if (taskDetails) {
          tasks.push(taskDetails);
        }
      }

      return tasks;
    } catch (error) {
      console.error('Error getting floor queue tasks:', error);
      throw error;
    }
  }

  /**
   * Lấy danh sách tasks trong hàng đợi tổng
   * @param {number} limit - Giới hạn số lượng (0 = all)
   * @returns {Array} Mảng tasks
   */
  async getGlobalQueueTasks(limit = 10) {
    try {
      return await lifterQueueService.getGlobalQueue(limit);
    } catch (error) {
      console.error('Error getting global queue tasks:', error);
      throw error;
    }
  }

  /**
   * Xóa toàn bộ hàng đợi (dùng cho testing)
   * @returns {boolean} Success
   */
  async clearAllQueues() {
    try {
      return await lifterQueueService.clearAllQueues();
    } catch (error) {
      console.error('Error clearing all queues:', error);
      throw error;
    }
  }

  async moveLifterToFloor(logicalFloorId, plcId = 'PLC_1') {
    try {
      const targetFloor = this.mapFloorIdToLifterIndex(logicalFloorId);

      if (!targetFloor) {
        throw new Error(`Tầng mục tiêu không hợp lệ: ${logicalFloorId}. Phải là 138 (Tầng 1) hoặc 139 (Tầng 2).`);
      }

      logger.info(`[LifterService] Yêu cầu di chuyển lifter tới tầng vật lý: ${targetFloor} (ID: ${logicalFloorId})`);

      // 1. Đọc vị trí hiện tại
      const posF1 = plcManager.getValue(plcId, 'LIFTER_1_POS_F1');
      const posF2 = plcManager.getValue(plcId, 'LIFTER_1_POS_F2');
      const currentFloor = posF1 ? 1 : posF2 ? 2 : 0;
      console.log('currentFloor', currentFloor);

      if (currentFloor === targetFloor) {
        return { success: true, message: `Lifter đã ở tầng ${targetFloor}`, currentFloor };
      }

      // 2. Ghi lệnh điều khiển di chuyển
      const ctrlTag = targetFloor === 1 ? 'LIFTER_1_CTRL_F1' : 'LIFTER_1_CTRL_F2';
      const writeResult = await plcManager.writeValue(plcId, ctrlTag, true);

      if (writeResult?.error) {
        throw new Error(`Không thể ghi lệnh điều khiển xuống PLC: ${writeResult.error}`);
      }

      // 3. Giám sát lỗi và di chuyển (mô phỏng hoặc thực tế)
      let moveTime = 0;
      const maxMoveTime = 2000;
      const checkInterval = 500;

      const monitorMovement = () =>
        new Promise((resolve, reject) => {
          const timer = setInterval(async () => {
            moveTime += checkInterval;

            // Kiểm tra lỗi
            const hasError = plcManager.getValue(plcId, 'LIFTER_1_ERROR');
            if (hasError) {
              clearInterval(timer);
              return reject(new Error('Lifter gặp lỗi trong quá trình di chuyển!'));
            }

            logger.debug(`[LifterService] Đang di chuyển... (${moveTime}ms)`);

            if (moveTime >= maxMoveTime) {
              clearInterval(timer);
              resolve();
            }
          }, checkInterval);
        });

      await monitorMovement();

      // 4. Khi đến nơi, cập nhật vị trí sensor (Giả lập cập nhật PLC tags)
      const targetPosTag = targetFloor === 1 ? 'LIFTER_1_POS_F1' : 'LIFTER_1_POS_F2';
      const oldPosTag = targetFloor === 1 ? 'LIFTER_1_POS_F2' : 'LIFTER_1_POS_F1';

      await plcManager.writeValue(plcId, targetPosTag, true);
      await plcManager.writeValue(plcId, oldPosTag, false);
      await plcManager.writeValue(plcId, ctrlTag, false); // Tắt lệnh điều khiển

      logger.info(`[LifterService] Đã đến tầng ${targetFloor}. Cập nhật sensor.`);

      return {
        success: true,
        message: `Đã di chuyển lifter tới tầng ${targetFloor} thành công`,
        previousFloor: currentFloor,
        currentFloor: targetFloor,
      };
    } catch (error) {
      logger.error(`[LifterService] Error in moveLifterToFloor: ${error.message}`);
      throw error;
    }
  }
}

module.exports = LifterService;
