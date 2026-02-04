const QueueRepository = require('./QueueRepository');
const TaskPriorityCalculator = require('./TaskPriorityCalculator');
const AMRLogger = require('../utils/AMRLogger');
const config = require('../config/amr.dispatcher.config');

class AMRTaskQueueService {
    async addTask(task) {
        try {
            const taskWithMetadata = {
                ...task,
                taskId: task.taskId || `task-${Date.now()}`,
                status: 'PENDING',
                createdAt: Date.now(),
                priority: TaskPriorityCalculator.calculatePriority(task)
            };

            await QueueRepository.addTask(taskWithMetadata);

            AMRLogger.queue('Task added', {
                taskId: taskWithMetadata.taskId,
                priority: taskWithMetadata.priority
            });

            return taskWithMetadata;
        } catch (error) {
            AMRLogger.error('TaskQueue', 'Failed to add task', error);
            throw error;
        }
    }

    async getNextTask() {
        try {
            const task = await QueueRepository.getNextTask();

            if (!task) return null;
            if (task.status !== 'PENDING') return null;

            return task;
        } catch (error) {
            AMRLogger.error('TaskQueue', 'Failed to get next task', error);
            return null;
        }
    }

    async updateTaskStatus(taskId, status, assignedAMR = null) {
        try {
            const updates = {
                status,
                updatedAt: Date.now()
            };

            if (assignedAMR) {
                updates.assignedAMR = assignedAMR;
                updates.assignedAt = Date.now();
            }

            await QueueRepository.updateTask(taskId, updates);

            AMRLogger.queue('Task status updated', { taskId, status, assignedAMR });
            return true;
        } catch (error) {
            AMRLogger.error('TaskQueue', 'Failed to update task status', error);
            return false;
        }
    }

    async completeTask(taskId) {
        try {
            await this.updateTaskStatus(taskId, 'COMPLETED');
            await QueueRepository.removeTask(taskId);

            AMRLogger.queue('Task completed and removed', { taskId });
            return true;
        } catch (error) {
            AMRLogger.error('TaskQueue', 'Failed to complete task', error);
            return false;
        }
    }

    async cancelTask(taskId, reason) {
        try {
            await QueueRepository.updateTask(taskId, {
                status: 'CANCELLED',
                cancelledAt: Date.now(),
                cancelReason: reason
            });

            AMRLogger.queue('Task cancelled', { taskId, reason });
            return true;
        } catch (error) {
            AMRLogger.error('TaskQueue', 'Failed to cancel task', error);
            return false;
        }
    }

    async getQueueLength() {
        return await QueueRepository.getQueueLength();
    }

    async getAllPendingTasks() {
        try {
            const allTasks = await QueueRepository.getAllTasks();
            return allTasks.filter(task => task.status === 'PENDING');
        } catch (error) {
            AMRLogger.error('TaskQueue', 'Failed to get pending tasks', error);
            return [];
        }
    }
}

module.exports = new AMRTaskQueueService();
