const mqtt = require('mqtt');

// --- Config ---
const MQTT_BROKER_URL = 'mqtt://localhost:1883';
const LOOP_INTERVAL = 500; 
const NODE_TRAVEL_TIME_MS = 3000;
const COMMAND_TOPIC = 'shuttle/command/+';
const INFO_TOPIC_PREFIX = 'shuttle/information/';
const EVENTS_TOPIC = 'shuttle/events'; 

const SHUTTLE_CONFIGS = [
    { code: '001', ip: '192.168.1.101', startQrCode: 'X0002Y0001' },
    { code: '002', ip: '192.168.1.102', startQrCode: 'X0003Y0001' }, 
    { code: '003', ip: '192.168.1.103', startQrCode: 'X0002Y0020' },
];

// --- Enums ---
const SHUTTLE_STATUS = { ERROR: 1, PICKING: 2, DROPPING: 3, WHEELS_UP: 4, WHEELS_DOWN: 5, SLOW_SPEED: 6, NORMAL_SPEED: 7, IDLE: 8, WAITING: 9 };
const COMMAND_COMPLETE = { IN_PROGRESS: 0, DONE: 1 };

// --- MQTT Client ---
const client = mqtt.connect(MQTT_BROKER_URL, {
    clientId: 'multi-shuttle-simulator-agents',
});

// --- Simulation State ---
let shuttleStates = SHUTTLE_CONFIGS.map(config => ({
    no: config.code,
    ip: config.ip,
    shuttleStatus: SHUTTLE_STATUS.IDLE,
    commandComplete: COMMAND_COMPLETE.DONE,
    qrCode: config.startQrCode, 
    path: [],
    currentPathIndex: 0,
    lastMoveTimestamp: 0,
}));

/**
 * Publishes a semantic event to the shuttle/events topic.
 * @param {string} eventName - The name of the event (e.g., 'shuttle-moved').
 * @param {string} shuttleNo - The shuttle's identifier.
 * @param {object} data - Additional data for the event.
 */
function publishEvent(eventName, shuttleNo, data = {}) {
    const eventPayload = {
        event: eventName,
        shuttleId: shuttleNo,
        timestamp: Date.now(),
        ...data,
    };
    client.publish(EVENTS_TOPIC, JSON.stringify(eventPayload), (err) => {
        if (err) {
            console.error(`[Simulator] Failed to publish event ${eventName} for ${shuttleNo}:`, err);
        } else {
            // console.log(`[Simulator] Published event ${eventName} for ${shuttleNo}`);
        }
    });
}

/**
 * Processes a single movement step for a shuttle, including conflict detection.
 * @param {object} state The shuttle state object.
 */
function processMovement(state) {
    // Process movement only for shuttles that are running or waiting and have a path.
    if (![SHUTTLE_STATUS.NORMAL_SPEED, SHUTTLE_STATUS.WAITING].includes(state.shuttleStatus) || state.path.length === 0) {
        return;
    }

    const now = Date.now();
    if (now - state.lastMoveTimestamp < NODE_TRAVEL_TIME_MS) {
        return; // Not time to move yet
    }

    // Determine the next node
    const nextNodeIndex = state.currentPathIndex + 1;
    if (nextNodeIndex >= state.path.length) {
        // Path is complete, move to idle state
        console.log(`[Simulator] Shuttle ${state.no} completed its path at ${state.qrCode}.`);
        publishEvent('shuttle-completed-path', state.no, { finalNode: state.qrCode });
        state.shuttleStatus = SHUTTLE_STATUS.IDLE;
        state.commandComplete = COMMAND_COMPLETE.DONE;
        state.path = [];
        state.currentPathIndex = 0;
        return;
    }
    const nextNode = state.path[nextNodeIndex];

    // --- Conflict Detection ---
    const isNodeOccupied = shuttleStates.some(
        otherShuttle => otherShuttle.no !== state.no && otherShuttle.qrCode === nextNode
    );

    if (isNodeOccupied) {
        if (state.shuttleStatus !== SHUTTLE_STATUS.WAITING) { // Only publish if status changes to WAITING
            state.shuttleStatus = SHUTTLE_STATUS.WAITING;
            console.log(`[Simulator] Shuttle ${state.no} is WAITING. Node ${nextNode} is occupied.`);
            publishEvent('shuttle-waiting', state.no, { waitingAt: state.qrCode, targetNode: nextNode });
        }
        return; // Halt movement
    }
    
    // If we were waiting but the node is now free, resume normal speed
    if (state.shuttleStatus === SHUTTLE_STATUS.WAITING) {
        console.log(`[Simulator] Shuttle ${state.no} resumes movement. Node ${nextNode} is now free.`);
        publishEvent('shuttle-resumed', state.no, { resumedFrom: state.qrCode, targetNode: nextNode });
    }
    state.shuttleStatus = SHUTTLE_STATUS.NORMAL_SPEED;
    
    // It's time to move
    state.currentPathIndex = nextNodeIndex;
    state.lastMoveTimestamp = now;
    state.qrCode = nextNode;
    console.log(`[Simulator] Shuttle ${state.no} moved to node: ${nextNode}`);
    publishEvent('shuttle-moved', state.no, { currentNode: state.qrCode });
}

// --- Main Logic ---

client.on('connect', () => {
    console.log(`[Simulator] Connected. Initializing ${SHUTTLE_CONFIGS.length} agents. Travel time is ${NODE_TRAVEL_TIME_MS / 1000}s/node.`);
    
    client.subscribe(COMMAND_TOPIC, (err) => {
        if (!err) {
            console.log(`[Simulator] Subscribed to command topic: ${COMMAND_TOPIC}`);
        }
    });

    // Main loop for processing movement and publishing state
    setInterval(() => {
        shuttleStates.forEach(state => {
            processMovement(state);

            const topic = `${INFO_TOPIC_PREFIX}${state.no}`;
            const payload = JSON.stringify(state);
            client.publish(topic, payload);
        });
    }, LOOP_INTERVAL);
});

client.on('message', (topic, message) => {
    const shuttleCode = topic.split('/')[2];
    const shuttle = shuttleStates.find(s => s.no === shuttleCode);

    if (!shuttle) {
        console.warn(`[Simulator] Received command for unknown shuttle: ${shuttleCode}`);
        return;
    }
    
    // Do not accept new paths if already running
    if (shuttle.shuttleStatus !== SHUTTLE_STATUS.IDLE) {
        console.log(`[Simulator] Shuttle ${shuttleCode} is busy, ignoring new path.`);
        return;
    }

    try {
        const path = JSON.parse(message.toString());
        if (Array.isArray(path) && path.length > 0) {
            console.log(`[Simulator] Shuttle ${shuttleCode} starting new path with ${path.length} nodes. First node: ${path[0]}`);
            publishEvent('shuttle-task-started', shuttle.no, { pathLength: path.length, startNode: path[0] });
            shuttle.path = path;
            shuttle.currentPathIndex = 0;
            // The first node in the path is the current location
            shuttle.qrCode = path[0]; 
            shuttle.shuttleStatus = SHUTTLE_STATUS.NORMAL_SPEED;
            shuttle.commandComplete = COMMAND_COMPLETE.IN_PROGRESS;
            shuttle.lastMoveTimestamp = Date.now(); // Start timer immediately
        }
    } catch (e) {
        console.error(`[Simulator] Failed to parse command for shuttle ${shuttleCode}:`, e);
    }
});

client.on('error', (err) => {
    console.error('[Simulator] Connection error:', err);
    client.end();
});