const express = require('express');
const lifterController = require('../../../controllers/lifter.controller');

const router = express.Router();

// Đăng ký nhiệm vụ cần sử dụng lifter
router.post('/request-task', lifterController.requestTask);

// Lấy task tiếp theo cần xử lý
router.get('/next-task', lifterController.getNextTask);

// Bắt đầu xử lý task
router.post('/start-task/:taskId', lifterController.startTask);

// Hoàn thành task
router.post('/complete-task/:taskId', lifterController.completeTask);

// Lấy thống kê hàng đợi
router.get('/queue-stats', lifterController.getQueueStats);

// Lấy hàng đợi của một tầng cụ thể
router.get('/floor-queue/:floorId', lifterController.getFloorQueue);

// Lấy hàng đợi tổng
router.get('/global-queue', lifterController.getGlobalQueue);

// Lấy chi tiết một task
router.get('/task/:taskId', lifterController.getTaskDetails);

// Xóa toàn bộ hàng đợi (testing only)
router.delete('/clear-queues', lifterController.clearQueues);

// Lấy thông tin lifter theo ID
router.get('/info/:lifterId', lifterController.getLifterInfo);

// Mô phỏng điều khiển và giám sát lifter
router.post('/simulate-control', lifterController.simulateControl);

module.exports = router;
