const aedes = require('aedes')();
const net = require('net');
const { logger } = require('../logger/logger');
const { updateShuttleState } = require('../modules/SHUTTLE/shuttleStateCache');

const MQTT_PORT = process.env.MQTT_PORT || 1883;

const server = net.createServer(aedes.handle);

function initializeMqttBroker(io) { // Accept io instance
    server.listen(MQTT_PORT, function () {
        logger.info(`MQTT Broker started and listening on port ${MQTT_PORT}`);
    });

    // Event listeners for broker logging
    aedes.on('client', function (client) {
        logger.info(`MQTT Client Connected: ${client.id}`);
    });

    aedes.on('clientDisconnect', function (client) {
        logger.info(`MQTT Client Disconnected: ${client.id}`);
    });

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
            } else if (topic === 'shuttle/events') { // Handle semantic events for frontend
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
    logger.info(`[MqttService] Attempting to publish to topic: ${topic}`); // <-- ADDED THIS LOG

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
        } else {
            logger.info(`[MqttService] PUBLISH CALLBACK: Successfully published command to ${topic}`);
        }
    });

    logger.info(`[MqttService] aedes.publish() called for ${topic}. Waiting for callback.`); // <-- ADDED THIS LOG
}

module.exports = { initializeMqttBroker, aedes, publishToTopic };
