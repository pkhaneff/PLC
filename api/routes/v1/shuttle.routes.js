const express = require('express');
const shuttleController = require('../../../controllers/shuttle.controller');

const router = express.Router();

router.post('/node', shuttleController.nodeFinding)

router.post('/register', shuttleController.registerShuttle);
router.post('/update-position', shuttleController.updatePosition);
router.post('/auto-mode', shuttleController.autoMode);

router.post('/pallet-inbound', shuttleController.registerInbound);
router.post('/execute-storage', shuttleController.executeStorageTask);
router.post('/stop-executing', shuttleController.stopExecutingMode);
router.get('/executing-shuttles', shuttleController.getExecutingShuttles);

module.exports = router;  