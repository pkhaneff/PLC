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
                    
                    // 1. Update the shuttle's state in the in-memory cache
                    updateShuttleState(shuttleCode, payload);

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
    const packet = {
        cmd: 'publish',
        topic: topic,
        payload: JSON.stringify(payload),
        qos: 1, // At least once
        retain: false,
    };
    aedes.publish(packet, (err) => {
        if (err) {
            logger.error(`[MqttService] Error publishing to ${topic}:`, err);
        } else {
            logger.info(`[MqttService] Published command to ${topic}`);
        }
    });
}

module.exports = { initializeMqttBroker, aedes, publishToTopic };
