const { amrPollerManager } = require('../modules/AMR');

class AMRDataController {
    async getAMRData(req, res) {
        try {
            const { amr_id } = req.params;
            const data = await amrPollerManager.getAMRData(amr_id);

            if (!data) {
                return res.status(404).json({
                    success: false,
                    message: `AMR ${amr_id} not found`
                });
            }

            return res.status(200).json({
                success: true,
                data
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    async getAllAMRData(req, res) {
        try {
            const data = await amrPollerManager.getAllAMRData();

            return res.status(200).json({
                success: true,
                data
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
}

module.exports = new AMRDataController();
