const amrService = require('../modules/AMR/services/amr.service');
const { manager } = require('../modules/AMR');

class AMRController {
    /**
     * Generate path and execute task asynchronously (SHUTTLE pattern)
     * 1. Validate request and generate path
     * 2. Return success immediately with taskId and move_task_list
     * 3. Execute task in background with socket events
     */
    async generatePath(req, res) {
        try {
            const { start, end, action, amr_id } = req.body;

            // 1. Validation
            if (!start || !end) {
                return res.status(400).json({
                    success: false,
                    message: 'Start and end nodes are required'
                });
            }

            if (!amr_id) {
                return res.status(400).json({
                    success: false,
                    message: 'AMR ID (amr_id) is required'
                });
            }

            // 2. Validate and prepare path (synchronous)
            const validation = amrService.validateAndPreparePath(start, end, action);

            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    message: validation.error
                });
            }

            // 3. Generate unique task ID
            const taskId = `amr_task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // 4. Return success immediately (BEFORE execution)
            res.status(200).json({
                success: true,
                message: 'Task queued successfully',
                data: {
                    taskId,
                    move_task_list: validation.move_task_list,
                    status: 'queued',
                    amrId: amr_id,
                    start,
                    end,
                    action
                }
            });

            // 5. Execute task asynchronously in background (fire-and-forget)
            const taskData = {
                taskId,
                amrId: amr_id,
                start,
                end,
                action,
                move_task_list: validation.move_task_list
            };

            // Don't await - let it run in background
            manager.executeTaskAsync(taskData).catch(error => {
                console.error(`[AMRController] Background task execution failed for ${taskId}:`, error);
            });

        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }


}

module.exports = new AMRController();
