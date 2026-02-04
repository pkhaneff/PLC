const eventEmitter = require('../EventEmitter');
const { MQTT_EVENTS } = require('../EventTypes');
const { logger } = require('../../../config/logger');

class MQTTEventHandler {
    emitShuttleInfo(infoData) {
        const { shuttleId, ...data } = infoData;

        return eventEmitter.emit(MQTT_EVENTS.SHUTTLE_INFO, {
            shuttleId,
            ...data,
        });
    }

    emitShuttleEvent(eventData) {
        if (!eventData || !eventData.event) {
            logger.warn('[MQTTEventHandler] Invalid event data, missing event field');
            return false;
        }

        return eventEmitter.emit(eventData.event, eventData);
    }

    emitBrokerConnected(brokerInfo) {
        return eventEmitter.emit(MQTT_EVENTS.BROKER_CONNECTED, {
            broker: brokerInfo.broker || 'unknown',
            clientId: brokerInfo.clientId,
        });
    }

    emitBrokerDisconnected(brokerInfo) {
        return eventEmitter.emit(MQTT_EVENTS.BROKER_DISCONNECTED, {
            broker: brokerInfo.broker || 'unknown',
            reason: brokerInfo.reason,
        });
    }

    forwardEvent(eventName, payload) {
        return eventEmitter.emit(eventName, payload);
    }
}

module.exports = new MQTTEventHandler();
