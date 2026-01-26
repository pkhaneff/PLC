const express = require('express');
const router = express.Router();
const healthController = require('../../../controllers/health.controller');

router.get('/', (req, res) => healthController.checkHealth(req, res));

module.exports = router;
