const mqtt = require('mqtt');
const { logger } = require('../config/logger');
const { updateShuttleState } = require('../modules/SHUTTLE/services/shuttleStateCache');

// MQTT Configuration
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://10.14.80.78:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || 'admin';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || 'thaco@123';
const MQTT_CLIENT_ID = 'backend-mqtt-client';

let _mqttClient = null;
let _io = null; // Socket.io instance for frontend communication

/**
 * Initialize MQTT client connection to external broker
 * @param {object} socketIo - Socket.io instance
 */
function initializeMqttClient(socketIo) {
  _io = socketIo;

  // Connect to external MQTT broker
  _mqttClient = mqtt.connect(MQTT_BROKER_URL, {
    clientId: MQTT_CLIENT_ID,
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clean: true,
    reconnectPeriod: 5000,
  });

  _mqttClient.on('connect', () => {
    logger.info(`[MqttClient] Connected to external MQTT broker at ${MQTT_BROKER_URL}`);

    // Subscribe to shuttle information topics
    _mqttClient.subscribe('shuttle/information/+', (err) => {
      if (err) {
        logger.error('[MqttClient] Failed to subscribe to shuttle/information/+:', err);
      } else {
        logger.info('[MqttClient] Subscribed to shuttle/information/+');
      }
    });

    // Subscribe to shuttle events
    _mqttClient.subscribe('shuttle/events', (err) => {
      if (err) {
        logger.error('[MqttClient] Failed to subscribe to shuttle/events:', err);
      } else {
        logger.info('[MqttClient] Subscribed to shuttle/events');
      }
    });
  });

  _mqttClient.on('message', async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());

      // Handle shuttle information topic
      if (topic.startsWith('shuttle/information/')) {
        const shuttleCode = topic.split('/')[2];
        logger.debug(`[MqttClient] Received state update for shuttle ${shuttleCode}`);

        // Update shuttle state in Redis
        await updateShuttleState(shuttleCode, payload);
      }
      // Handle shuttle events
      else if (topic === 'shuttle/events') {
        if (_io && payload && payload.event) {
          _io.emit(payload.event, payload);
          logger.debug(`[MqttClient] Emitted socket event: ${payload.event} for shuttle ${payload.shuttleId}`);
        }
      }
    } catch (error) {
      logger.error(`[MqttClient] Error processing message from topic ${topic}:`, error);
    }
  });

  _mqttClient.on('error', (error) => {
    logger.error('[MqttClient] Connection error:', error);
  });

  _mqttClient.on('reconnect', () => {
    logger.warn('[MqttClient] Reconnecting to MQTT broker...');
  });

  _mqttClient.on('close', () => {
    logger.warn('[MqttClient] Connection closed');
  });

  return _mqttClient;
}

/**
 * Publish message to MQTT topic
 * @param {string} topic - MQTT topic
 * @param {object} payload - Message payload
 * @returns {Promise<void>}
 */
async function publishToTopic(topic, payload) {
  if (!_mqttClient || !_mqttClient.connected) {
    logger.error('[MqttClient] Cannot publish: MQTT client not connected');
    return;
  }

  const message = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    _mqttClient.publish(topic, message, { qos: 1 }, (err) => {
      if (err) {
        logger.error(`[MqttClient] Error publishing to ${topic}:`, err);
        reject(err);
      } else {
        logger.debug(`[MqttClient] Published to ${topic}`);
        resolve();
      }
    });
  });
}

/**
 * Get MQTT client instance
 * @returns {object} MQTT client
 */
function getClient() {
  return _mqttClient;
}

module.exports = {
  initializeMqttClient,
  publishToTopic,
  getClient,
};
