const express = require('express');
const router = express.Router();
const amrController = require('../../../controllers/amr.controller');
const amrDataController = require('../../../controllers/amrData.controller');

router.post('/generate-path', amrController.generatePath.bind(amrController));
router.get('/data/:amr_id', amrDataController.getAMRData.bind(amrDataController));
router.get('/data', amrDataController.getAllAMRData.bind(amrDataController));

module.exports = router;

