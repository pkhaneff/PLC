const { createClient } = require('redis');

const redis = createClient({
  url: 'redis://127.0.0.1:6379',
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('Redis: Max reconnection attempts reached');
        return new Error('Max reconnection attempts reached');
      }
      const delay = Math.min(retries * 100, 3000);
      console.log(`Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
      return delay;
    },
    connectTimeout: 10000,
  },
});

// Event handlers
redis.on('connect', () => {
  console.log('✓ Redis connected');
});

redis.on('ready', () => {
  console.log('✓ Redis client ready');
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redis.on('reconnecting', () => {
  console.log('⟳ Redis reconnecting...');
});

redis.on('end', () => {
  console.log('✗ Redis connection closed');
});

(async () => {
  try {
    await redis.connect();
  } catch (error) {
    console.error('Failed to connect to Redis:', error.message);
    process.exit(1);
  }
})();

module.exports = redis;
