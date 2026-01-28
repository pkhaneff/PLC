const aedes = require('aedes')();
const net = require('net');
const { logger } = require('../config/logger');
const { updateShuttleState } = require('../modules/SHUTTLE/services/shuttleStateCache');

const MQTT_PORT = process.env.MQTT_PORT || 1883;

const _server = net.createServer(aedes.handle);

/**
 * Initialize internal MQTT broker.
 * @param {object} io - Socket.io instance
 */
function initializeMqttBroker(io) {
  _server.listen(MQTT_PORT);

  // Event listeners for broker logging
  aedes.on('publish', async function (packet, client) {
    if (client) {
      const topic = packet.topic;
      logger.debug(`MQTT Message Published from ${client.id} on topic ${topic}`);

      // Handle shuttle information topic
      if (topic.startsWith('shuttle/information/')) {
        try {
          const payload = JSON.parse(packet.payload.toString());
          const shuttleCode = topic.split('/')[2];

          // Update shuttle state in Redis
          await updateShuttleState(shuttleCode, payload);
        } catch (error) {
          logger.error(`Error parsing MQTT info message from ${client.id}:`, error);
        }
      } else if (topic === 'shuttle/events') {
        // Handle semantic events for frontend
        try {
          const mqttEvent = JSON.parse(packet.payload.toString());
          if (io && mqttEvent && mqttEvent.event) {
            io.emit(mqttEvent.event, mqttEvent);
            logger.debug(`[MqttService] Emitted socket event: ${mqttEvent.event} for shuttle ${mqttEvent.shuttleId}`);
          }
        } catch (error) {
          logger.error(`Error parsing MQTT event message from ${client.id}:`, error);
        }
      }
    }
  });
}

/**
 * Publish message to internal MQTT topic.
 * @param {string} topic - MQTT topic
 * @param {object} payload - Message payload
 */
function publishToTopic(topic, payload) {
  const payloadBuffer = Buffer.from(JSON.stringify(payload));

  const packet = {
    cmd: 'publish',
    topic: topic,
    payload: payloadBuffer,
    qos: 1,
    retain: false,
  };

  aedes.publish(packet, (err) => {
    if (err) {
      logger.error(`[MqttService] PUBLISH CALLBACK: Error publishing to ${topic}:`, err);
    }
  });
}

module.exports = { initializeMqttBroker, aedes, publishToTopic };
