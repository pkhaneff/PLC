const aedes = require('aedes')();
const net = require('net');
const { logger } = require('../config/logger');
const { updateShuttleState } = require('../modules/SHUTTLE/services/shuttleStateCache');

const MQTT_PORT = process.env.MQTT_PORT || 1883;

const server = net.createServer(aedes.handle);

function initializeMqttBroker(io) {
  // Accept io instance
  server.listen(MQTT_PORT);

  // Event listeners for broker logging
  aedes.on('publish', async function (packet, client) {
    if (client) {
      const topic = packet.topic;
      // Using debug level to avoid spamming logs with every 300ms message
      logger.debug(`MQTT Message Published from ${client.id} on topic ${topic}`);

      // Handle shuttle information topic
      if (topic.startsWith('shuttle/information/')) {
        try {
          const payload = JSON.parse(packet.payload.toString());
          const shuttleCode = topic.split('/')[2];

          // CRITICAL FIX: Update shuttle state in Redis (now async)
          // This allows all processes to access the same state
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

function publishToTopic(topic, payload) {
  const payloadBuffer = Buffer.from(JSON.stringify(payload)); // <-- Ensure payload is a Buffer

  const packet = {
    cmd: 'publish',
    topic: topic,
    payload: payloadBuffer,
    qos: 1,
    retain: false,
  };

  aedes.publish(packet, (err) => {
    // This callback should ALWAYS execute, even if err is null.
    if (err) {
      logger.error(`[MqttService] PUBLISH CALLBACK: Error publishing to ${topic}:`, err);
    }
  });
}

module.exports = { initializeMqttBroker, aedes, publishToTopic };
