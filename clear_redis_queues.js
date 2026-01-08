const shuttleTaskQueueService = require('./modules/SHUTTLE/shuttleTaskQueueService');
const redisClient = require('./redis/init.redis');
const { logger } = require('./logger/logger'); // Import logger

async function run() {
    console.log('Connecting to Redis...');
    // Ensure redisClient is connected
    if (!redisClient.isOpen) {
        // Wait for 'connect' event if not already open
        await new Promise((resolve, reject) => {
            redisClient.on('connect', resolve);
            redisClient.on('error', reject);
        });
    }
    logger.info('Redis connected. Clearing all shuttle task queues and processing tasks...');
    try {
        const success = await shuttleTaskQueueService.clearAllQueues();
        if (success) {
            logger.info('Successfully cleared all shuttle task queues and processing tasks.');
        } else {
            logger.warn('Failed to clear shuttle task queues. Check logs for details.');
        }
    } catch (error) {
        logger.error('An error occurred while clearing queues:', error);
    } finally {
        // Close the Redis connection to allow the script to exit.
        await redisClient.quit();
        logger.info('Redis connection closed.');
    }
}

run();