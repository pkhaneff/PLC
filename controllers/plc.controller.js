const plcManager = require('../modules/PLC/plcManager');
const workerManager = require('../worker/workerManager');
const { randomUUID } = require('crypto');
const { asyncHandler } = require('../middlewares/error.middleware');
const { processWorkerTask } = require('../middlewares/workerProcessor.middleware');
const { logger } = require('../config/logger');

class PLCController {
  getAllPLCs(req, res) {
    try {
      const plcIds = plcManager.getAllPLCIds();
      const plcsInfo = plcIds.map((plcId) => {
        const status = plcManager.getConnectionStats(plcId);
        return {
          id: plcId,
          isConnected: status?.isConnected || false,
          totalTags: status?.totalTags || 0,
          validTags: status?.validTags || 0,
          reconnectAttempts: status?.reconnectAttempts || 0,
        };
      });

      res.json({
        totalPLCs: plcIds.length,
        plcs: plcsInfo,
      });
    } catch (error) {
      logger.error('[PLCController] Error getting all PLCs:', error);
      res.status(500).json({
        error: 'Failed to retrieve PLCs information',
        message: error.message,
      });
    }
  }

  getPLC(req, res) {
    try {
      const { plcId } = req.params;
      const reader = plcManager.getPLCReader(plcId);

      if (!reader) {
        return res.status(404).json({
          error: `PLC '${plcId}' not found`,
        });
      }

      const status = plcManager.getConnectionStats(plcId);
      const allValues = plcManager.getAllValues(plcId);

      res.json({
        plcId,
        status,
        totalTags: Object.keys(allValues).length,
        data: allValues,
      });
    } catch (error) {
      logger.error('[PLCController] Error getting PLC:', error);
      res.status(500).json({
        error: 'Failed to retrieve PLC information',
        message: error.message,
      });
    }
  }

  getPLCStats(req, res) {
    try {
      const { plcId } = req.params;
      const status = plcManager.getConnectionStats(plcId);

      if (!status) {
        return res.status(404).json({
          error: `PLC '${plcId}' not found`,
        });
      }

      res.json({
        plcId,
        status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[PLCController] Error getting PLC stats:', error);
      res.status(500).json({
        error: 'Failed to retrieve PLC statistics',
        message: error.message,
      });
    }
  }

  getValues(req, res) {
    try {
      const { plcId } = req.params;
      const { prefix } = req.query;

      let values;
      if (prefix) {
        values = plcManager.getValuesByPrefix(plcId, prefix);
      } else {
        values = plcManager.getAllValues(plcId);
      }

      if (!values || Object.keys(values).length === 0) {
        return res.status(404).json({
          error: prefix
            ? `No variables found with prefix '${prefix}' in PLC '${plcId}'`
            : `PLC '${plcId}' not found or has no data`,
        });
      }

      res.json({
        plcId,
        filter: prefix ? { prefix } : null,
        count: Object.keys(values).length,
        values,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[PLCController] Error getting values:', error);
      res.status(500).json({
        error: 'Failed to retrieve values',
        message: error.message,
      });
    }
  }

  processAvailablePLC = asyncHandler(async (req, res, next) => {
    const availablePlcId = plcManager.getActivePLC();

    if (!availablePlcId) {
      return res.status(404).json({
        success: false,
        error: 'No available PLC found',
        message: 'All PLCs are busy or disconnected',
      });
    }

    const taskId = randomUUID();

    logger.debug(`[PLCController] Task created: ${taskId} for ${availablePlcId}`);

    res.status(200).json({
      success: true,
      message: `[PLCController] PLC ${availablePlcId} is available, ready for execution`,
      data: {
        taskId,
        plcId: availablePlcId,
        status: 'processing',
      },
    });

    processWorkerTask(taskId, availablePlcId).catch((error) => {
      logger.error('[PLCController] Error processing worker task:', error);
    });
  });

  setPlcActive(req, res) {
    try {
      const { plcId } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'isActive must be a boolean',
        });
      }

      const success = plcManager.setPlcActive(plcId, isActive);

      if (!success) {
        return res.status(404).json({
          success: false,
          error: 'PLC not found',
          message: `PLC '${plcId}' not found`,
        });
      }

      res.json({
        success: true,
        message: `PLC ${plcId} ${isActive ? 'activated' : 'deactivated'}`,
        data: {
          plcId,
          isActive,
        },
      });
    } catch (error) {
      logger.error('[PLCController] Error setting PLC active:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to set PLC active',
        message: error.message,
      });
    }
  }
}

module.exports = new PLCController();
