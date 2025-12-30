const express = require('express');
const plcController = require('../../../controllers/plc.controller');

const router = express.Router();

router.get('/', plcController.getAllPLCs);
router.get('/:plcId', plcController.getPLC);
router.get('/:plcId/stats', plcController.getPLCStats);
router.get('/:plcId/values', plcController.getValues);
router.put('/:plcId/active', plcController.setPlcActive);
router.post('/process', plcController.processAvailablePLC);

module.exports = router;
 