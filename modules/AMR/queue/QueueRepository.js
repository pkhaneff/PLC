const redisClient = require('../../../redis/init.redis');
const AMRLogger = require('../utils/AMRLogger');

class QueueRepository {
    constructor() {
        this.queueKey = 'amr:task:queue';
        this.taskPrefix = 'amr:task:';
    }

    async addTask(task) {
        try {
            const taskId = task.taskId;
            const taskKey = `${this.taskPrefix}${taskId}`;

            await redisClient.set(taskKey, JSON.stringify(task));
            await redisClient.rPush(this.queueKey, taskId);

            AMRLogger.queue('Task added to queue', { taskId });
            return true;
        } catch (error) {
            AMRLogger.error('Queue', 'Failed to add task', error);
            throw error;
        }
    }

    async getNextTask() {
        try {
            const taskId = await redisClient.lIndex(this.queueKey, 0);
            if (!taskId) return null;

            const taskKey = `${this.taskPrefix}${taskId}`;
            const taskData = await redisClient.get(taskKey);

            return taskData ? JSON.parse(taskData) : null;
        } catch (error) {
            AMRLogger.error('Queue', 'Failed to get next task', error);
            throw error;
        }
    }

    async removeTask(taskId) {
        try {
            const taskKey = `${this.taskPrefix}${taskId}`;

            await redisClient.lRem(this.queueKey, 1, taskId);
            await redisClient.del(taskKey);

            AMRLogger.queue('Task removed from queue', { taskId });
            return true;
        } catch (error) {
            AMRLogger.error('Queue', 'Failed to remove task', error);
            throw error;
        }
    }

    async updateTask(taskId, updates) {
        try {
            const taskKey = `${this.taskPrefix}${taskId}`;
            const taskData = await redisClient.get(taskKey);

            if (!taskData) return false;

            const task = JSON.parse(taskData);
            const updatedTask = { ...task, ...updates };

            await redisClient.set(taskKey, JSON.stringify(updatedTask));
            return true;
        } catch (error) {
            AMRLogger.error('Queue', 'Failed to update task', error);
            throw error;
        }
    }

    async getQueueLength() {
        try {
            return await redisClient.lLen(this.queueKey);
        } catch (error) {
            AMRLogger.error('Queue', 'Failed to get queue length', error);
            return 0;
        }
    }

    async getAllTasks() {
        try {
            const taskIds = await redisClient.lRange(this.queueKey, 0, -1);
            const tasks = [];

            for (const taskId of taskIds) {
                const taskKey = `${this.taskPrefix}${taskId}`;
                const taskData = await redisClient.get(taskKey);
                if (taskData) {
                    tasks.push(JSON.parse(taskData));
                }
            }

            return tasks;
        } catch (error) {
            AMRLogger.error('Queue', 'Failed to get all tasks', error);
            return [];
        }
    }
}

module.exports = new QueueRepository();
