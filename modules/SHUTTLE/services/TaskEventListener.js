const mqtt = require('mqtt');
const { logger } = require('../../../logger/logger');
const redisClient = require('../../../redis/init.redis');
const shuttleTaskQueueService = require('./shuttleTaskQueueService');
const ConflictResolutionService = require('./ConflictResolutionService');
const LifterEventHandler = require('./LifterEventHandler');
const MovementEventHandler = require('./MovementEventHandler');
const InboundTaskHandler = require('../IN/InboundTaskHandler');

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://10.14.80.78:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || 'admin';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || 'thaco@123';

class TaskEventListener {
    constructor() {
        this.client = null;
        this.EVENTS_TOPIC = 'shuttle/events';
        this.dispatcher = null;
    }

    setDispatcher(dispatcher) {
        this.dispatcher = dispatcher;
    }

    initialize() {
        logger.info('[TaskEventListener] Initializing MQTT connection...');
        this.client = mqtt.connect(MQTT_BROKER_URL, {
            clientId: `task_event_listener_${Date.now()}`,
            username: MQTT_USERNAME,
            password: MQTT_PASSWORD,
        });

        this.client.on('connect', () => {
            logger.info('[TaskEventListener] Connected to MQTT broker');
            this.client.subscribe(this.EVENTS_TOPIC, (err) => {
                if (err) logger.error(`[TaskEventListener] Failed to subscribe: ${err}`);
                else logger.info(`[TaskEventListener] Subscribed to ${this.EVENTS_TOPIC}`);
            });
        });

        this.client.on('message', (topic, message) => {
            if (topic === this.EVENTS_TOPIC) this.handleEvent(message);
        });

        this.client.on('error', (err) => logger.error('[TaskEventListener] MQTT error:', err));

        // Redis Subscriber for Lifter Events
        this.subscriber = redisClient.duplicate();
        this.subscriber.connect().then(() => {
            logger.info('[TaskEventListener] Redis Subscriber connected');
            this.subscriber.subscribe('lifter:events', (msg) => {
                try {
                    LifterEventHandler.handleLifterEvent(JSON.parse(msg), this.dispatcher);
                } catch (e) {
                    logger.error('[TaskEventListener] Error parsing lifter event:', e);
                }
            });
        });
    }

    async handleEvent(message) {
        try {
            if (!message || message.length === 0) return;
            const payload = JSON.parse(message.toString());
            let { event, taskId, shuttleId } = payload;

            // Extract taskId if missing
            if (!taskId) {
                if (payload.taskInfo?.taskId) taskId = payload.taskInfo.taskId;
                else if (payload.meta?.taskId) taskId = payload.meta.taskId;
            }

            logger.info(`[TaskEventListener] Event: ${event}, Shuttle: ${shuttleId}, Task: ${taskId}`);
            if (!event) return;

            switch (event) {
                case 'WAITING_FOR_LIFTER':
                    if (taskId) await shuttleTaskQueueService.updateTaskStatus(taskId, 'waiting_for_lifter');
                    await LifterEventHandler.handleWaitingForLifter(shuttleId, payload, this.dispatcher);
                    break;

                case 'shuttle-task-started':
                    if (taskId) await shuttleTaskQueueService.updateTaskStatus(taskId, 'in_progress');
                    break;

                case 'PICKUP_COMPLETE':
                    if (taskId) await InboundTaskHandler.handlePickupComplete(taskId, shuttleId, this.dispatcher);
                    break;

                case 'ARRIVED_AT_LIFTER':
                    if (shuttleId) await LifterEventHandler.handleArrivedAtLifter(shuttleId, payload, this.dispatcher);
                    break;

                case 'TASK_COMPLETE':
                    if (taskId) await InboundTaskHandler.handleTaskComplete(taskId, shuttleId, this.dispatcher);
                    break;

                case 'shuttle-waiting':
                    await ConflictResolutionService.handleConflict(shuttleId, payload);
                    break;

                case 'shuttle-moved':
                    await MovementEventHandler.handleShuttleMoved(shuttleId, payload, this.dispatcher);
                    break;

                case 'shuttle-initialized':
                    await MovementEventHandler.handleShuttleInitialized(shuttleId, payload);
                    break;

                default:
                    logger.debug(`[TaskEventListener] Ignoring event: ${event}`);
            }
        } catch (error) {
            logger.error(`[TaskEventListener] Error handling event:`, error);
        }
    }
}

module.exports = new TaskEventListener();
