const SHUTTLE_EVENTS = Object.freeze({
    TASK_QUEUED: 'shuttle:task:queued',
    TASK_ASSIGNED: 'shuttle:task:assigned',
    TASK_STARTED: 'shuttle:task:started',
    TASK_PROGRESS: 'shuttle:task:progress',
    TASK_COMPLETED: 'shuttle:task:completed',
    TASK_FAILED: 'shuttle:task:failed',
    STATE_UPDATED: 'shuttle:state:updated',
});

const MQTT_EVENTS = Object.freeze({
    SHUTTLE_INFO: 'mqtt:shuttle:info',
    SHUTTLE_EVENT: 'mqtt:shuttle:event',
    BROKER_CONNECTED: 'mqtt:broker:connected',
    BROKER_DISCONNECTED: 'mqtt:broker:disconnected',
});

const PLC_EVENTS = Object.freeze({
    PROCESSING_COMPLETE: 'plc-processing-complete',
    PROCESSING_ERROR: 'plc-processing-error',
    STATUS_UPDATED: 'plc:status:updated',
});

const SYSTEM_EVENTS = Object.freeze({
    CLIENT_CONNECTED: 'system:client:connected',
    CLIENT_DISCONNECTED: 'system:client:disconnected',
    ERROR: 'system:error',
});

module.exports = {
    SHUTTLE_EVENTS,
    MQTT_EVENTS,
    PLC_EVENTS,
    SYSTEM_EVENTS,
};
