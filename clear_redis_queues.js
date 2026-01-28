const shuttleTaskQueueService = require('./modules/SHUTTLE/services/shuttleTaskQueueService');
const redisClient = require('./redis/init.redis');
const { logger } = require('./config/logger'); // Import logger

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
  try {
    const success = await shuttleTaskQueueService.clearAllQueues();
  } catch (error) {
    logger.error('An error occurred while clearing queues:', error);
  } finally {
    // Close the Redis connection to allow the script to exit.
    await redisClient.quit();
  }
}

run();
