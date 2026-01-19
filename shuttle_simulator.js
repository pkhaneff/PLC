const mqtt = require('mqtt');
const cellService = require('./modules/SHUTTLE/cellService');
const { SHUTTLE_STATUS, TASK_ACTIONS, MQTT_TOPICS, MISSION_CONFIG } = require('./config/shuttle.config');

// --- Config ---
const MQTT_BROKER_URL = 'mqtt://localhost:1883';
const LOOP_INTERVAL = 500;
const NODE_TRAVEL_TIME_MS = 500;
const COMMAND_TOPIC = 'shuttle/command/+';
const SEND_MISSION_TOPIC = 'shuttle/sendMission/+';
const INFO_TOPIC_PREFIX = 'shuttle/information/';
const EVENTS_TOPIC = 'shuttle/events';

const SHUTTLE_CONFIGS = [
    { code: '001', ip: '192.168.1.101', startQrCode: 'X0002Y0020' },
    // { code: '002', ip: '192.168.1.102', startQrCode: 'X0003Y0001' },
    { code: '003', ip: '192.168.1.103', startQrCode: 'X0003Y0020' },
];

// --- Enums ---
const COMMAND_COMPLETE = { IN_PROGRESS: 0, DONE: 1 };

// --- MQTT Client ---
const client = mqtt.connect(MQTT_BROKER_URL, {
    clientId: 'multi-shuttle-simulator-agents',
});

// --- Simulation State ---
let shuttleStates = SHUTTLE_CONFIGS.map(config => ({
    no: config.code,
    ip: config.ip,
    currentStep: 0,
    shuttleStatus: SHUTTLE_STATUS.IDLE,
    commandComplete: COMMAND_COMPLETE.DONE,
    qrCode: config.startQrCode,
    packageStatus: 0,              // 0 = no package, 1 = has package, 2 = misaligned
    palletLiftingStatus: 0,        // 0 = down, 1 = up
    missionCompleted: 0,           // Total missions completed counter
    path: [],                      // Internal: Array of {qrCode, direction, action}
    currentPathIndex: 0,           // Internal: Current index in path
    lastMoveTimestamp: 0,          // Internal: Last movement time
    onArrival: null,               // Internal: What event to fire when path is complete
    taskInfo: null,                // Internal: The task context
    isCarrying: false,             // Internal: Track if shuttle is carrying cargo
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
            console.log(`[Simulator] Published event ${eventName} for ${shuttleNo}`);
        }
    });
}

/**
 * Processes a single movement step for a shuttle, including conflict detection.
 * @param {object} state The shuttle state object.
 */
async function processMovement(state) {
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
        const arrivalEvent = state.onArrival;
        const nodeName = await cellService.getDisplayNameWithoutFloor(state.qrCode);
        console.log(`[Simulator] Shuttle ${state.no} completed its path at ${nodeName}. Firing event: ${arrivalEvent}`);

        if (arrivalEvent) {
            // CRITICAL: Update cargo state BEFORE publishing event
            // This ensures backend sees correct isCarrying state when processing subsequent moves
            if (arrivalEvent === 'PICKUP_COMPLETE') {
                state.isCarrying = true;
                state.packageStatus = 1;
                state.palletLiftingStatus = 1; // Lift pallet up
                state.shuttleStatus = SHUTTLE_STATUS.PICKING; // Mark as picking
                console.log(`[Simulator] Shuttle ${state.no} picked up cargo, isCarrying=true, pallet lifted`);
            } else if (arrivalEvent === 'TASK_COMPLETE') {
                state.isCarrying = false;
                state.packageStatus = 0;
                state.palletLiftingStatus = 0; // Lower pallet down
                state.shuttleStatus = SHUTTLE_STATUS.DROPPING; // Mark as dropping
                state.missionCompleted++; // Increment mission counter
                console.log(`[Simulator] Shuttle ${state.no} dropped off cargo, isCarrying=false, pallet lowered, missions: ${state.missionCompleted}`);
            }

            // Publish event AFTER updating state
            publishEvent(arrivalEvent, state.no, { taskId: state.taskInfo.taskId });
        } else {
            console.warn(`[Simulator] Shuttle ${state.no} completed a path but had no onArrival event stored.`);
        }

        // Reset state and move to idle
        state.shuttleStatus = SHUTTLE_STATUS.IDLE;
        state.commandComplete = COMMAND_COMPLETE.DONE;
        state.path = [];
        state.currentPathIndex = 0;
        state.currentStep = 0;
        state.onArrival = null;
        state.taskInfo = null;
        return;
    }

    // Get next step (now includes qrCode, direction, and action)
    const nextStep = state.path[nextNodeIndex];
    const nextNode = typeof nextStep === 'string' ? nextStep : nextStep.qrCode;

    // --- Conflict Detection ---
    const blockingShuttle = shuttleStates.find(
        otherShuttle => otherShuttle.no !== state.no && otherShuttle.qrCode === nextNode
    );

    if (blockingShuttle) {
        if (state.shuttleStatus !== SHUTTLE_STATUS.WAITING) { // Only publish if status changes to WAITING
            state.shuttleStatus = SHUTTLE_STATUS.WAITING;
            const nextNodeName = await cellService.getDisplayNameWithoutFloor(nextNode);
            console.log(`[Simulator] Shuttle ${state.no} is WAITING. Node ${nextNodeName} is occupied by shuttle ${blockingShuttle.no}.`);
            publishEvent('shuttle-waiting', state.no, {
                waitingAt: state.qrCode,
                targetNode: nextNode,
                blockedBy: blockingShuttle.no
            });
            console.log(`[Simulator] Published event shuttle-waiting for ${state.no}`);
        }
        return; // Halt movement
    }

    // If we were waiting but the node is now free, resume normal speed
    if (state.shuttleStatus === SHUTTLE_STATUS.WAITING) {
        const nextNodeName = await cellService.getDisplayNameWithoutFloor(nextNode);
        console.log(`[Simulator] Shuttle ${state.no} resumes movement. Node ${nextNodeName} is now free.`);
        publishEvent('shuttle-resumed', state.no, { resumedFrom: state.qrCode, targetNode: nextNode });
    }
    state.shuttleStatus = SHUTTLE_STATUS.NORMAL_SPEED;

    // It's time to move - save previous node before updating
    const previousNode = state.qrCode;
    state.currentPathIndex = nextNodeIndex;
    state.currentStep = nextNodeIndex;
    state.lastMoveTimestamp = now;
    state.qrCode = nextNode;

    const prevNodeName = await cellService.getDisplayNameWithoutFloor(previousNode);
    const nextNodeName = await cellService.getDisplayNameWithoutFloor(nextNode);
    console.log(`[Simulator] Shuttle ${state.no} moved from ${prevNodeName} to ${nextNodeName}`);
    publishEvent('shuttle-moved', state.no, { currentNode: state.qrCode, previousNode: previousNode });
}

// --- Main Logic ---

client.on('connect', () => {
    console.log(`[Simulator] Connected. Initializing ${SHUTTLE_CONFIGS.length} agents. Travel time is ${NODE_TRAVEL_TIME_MS / 1000}s/node.`);

    // Subscribe to both command and sendMission topics
    client.subscribe([COMMAND_TOPIC, SEND_MISSION_TOPIC], (err) => {
        if (!err) {
            console.log(`[Simulator] Subscribed to topics: ${COMMAND_TOPIC}, ${SEND_MISSION_TOPIC}`);
        }
    });

    // Publish shuttle-initialized event for each shuttle to block initial nodes
    shuttleStates.forEach(async (state) => {
        publishEvent('shuttle-initialized', state.no, { initialNode: state.qrCode });
        const nodeName = await cellService.getDisplayNameWithoutFloor(state.qrCode);
        console.log(`[Simulator] Shuttle ${state.no} initialized at node ${nodeName}`);
    });

    // Main loop for processing movement and publishing state
    setInterval(() => {
        shuttleStates.forEach(async (state) => {
            await processMovement(state);

            // Publish shuttle information (only send fields needed by server)
            const topic = `${INFO_TOPIC_PREFIX}${state.no}`;
            const payload = JSON.stringify({
                no: state.no,
                ip: state.ip,
                currentStep: state.currentStep,
                shuttleStatus: state.shuttleStatus,
                commandComplete: state.commandComplete,
                qrCode: state.qrCode,
                packageStatus: state.packageStatus,
                palletLiftingStatus: state.palletLiftingStatus,
                missionCompleted: state.missionCompleted,
                taskId: state.taskInfo ? state.taskInfo.taskId : '',
                targetQr: state.taskInfo ? state.taskInfo.endNodeQr : ''
            });
            client.publish(topic, payload);
        });
    }, MISSION_CONFIG.PUBLISH_INTERVAL); // Use 300ms from config
});

/**
 * Parses a mission step in format: "QRCODE>direction:action"
 * @param {string} stepString - Step string
 * @returns {object} { qrCode, direction, action }
 */
function parseStepString(stepString) {
    const parts = stepString.split('>');
    const qrCode = parts[0];
    const directionAndAction = parts[1] ? parts[1].split(':') : ['1', '10'];
    const direction = parseInt(directionAndAction[0], 10);
    const action = directionAndAction[1] ? parseInt(directionAndAction[1], 10) : TASK_ACTIONS.NO_ACTION;

    return { qrCode, direction, action };
}

client.on('message', async (topic, message) => {
    const topicParts = topic.split('/');
    const topicType = topicParts[1];
    const shuttleCode = topicParts[2];
    const shuttle = shuttleStates.find(s => s.no === shuttleCode);

    if (!shuttle) {
        console.warn(`[Simulator] Received message for unknown shuttle: ${shuttleCode}`);
        return;
    }

    // Do not accept new paths if already running
    if (shuttle.shuttleStatus !== SHUTTLE_STATUS.IDLE) {
        return;
    }

    try {
        const command = JSON.parse(message.toString());

        if (topicType === 'sendMission' && command.totalStep) {
            console.log(`[Simulator] Shuttle ${shuttleCode} received sendMission with ${command.totalStep} steps`);

            shuttle.commandComplete = COMMAND_COMPLETE.IN_PROGRESS;
            console.log(`[Simulator] Shuttle ${shuttleCode} acknowledged mission (commandComplete=0)`);

            // Parse the mission steps with actions
            const newPath = [];
            for (let i = 1; i <= command.totalStep; i++) {
                const stepString = command[`step${i}`];
                if (stepString) {
                    const stepData = parseStepString(stepString);
                    newPath.push(stepData);
                }
            }

            if (newPath.length > 0) {
                // Extract metadata
                const onArrival = command.meta?.onArrival || 'TASK_COMPLETE';
                const taskInfo = command.meta || {};

                // Log path for debugging
                try {
                    const pathNames = await Promise.all(
                        newPath.map(step => cellService.getDisplayNameWithoutFloor(step.qrCode))
                    );
                    const pathWithActions = newPath.map((step, idx) =>
                        `${pathNames[idx]}(dir:${step.direction},act:${step.action})`
                    );
                    console.log(`[Simulator] Shuttle ${shuttleCode} mission path: [${pathWithActions.join(' -> ')}]`);
                } catch (error) {
                    console.error(`[Simulator] Error getting path names:`, error.message);
                }

                // Set shuttle state
                publishEvent('shuttle-task-started', shuttle.no, { pathLength: newPath.length, startNode: newPath[0].qrCode });

                shuttle.path = newPath;
                shuttle.onArrival = onArrival;
                shuttle.taskInfo = taskInfo;
                shuttle.currentPathIndex = 0;
                shuttle.currentStep = 0;
                shuttle.qrCode = newPath[0].qrCode; // Start at first node
                shuttle.shuttleStatus = SHUTTLE_STATUS.NORMAL_SPEED;
                // commandComplete already set to IN_PROGRESS above for immediate ACK
                shuttle.lastMoveTimestamp = Date.now();
            }

            // Handle legacy format: shuttle/command/{code}
        } else if (topicType === 'command' && command.path && command.onArrival) {
            console.log(`[Simulator] Shuttle ${shuttleCode} received legacy command format`);

            // CRITICAL: Acknowledge immediately
            shuttle.commandComplete = COMMAND_COMPLETE.IN_PROGRESS;
            console.log(`[Simulator] Shuttle ${shuttleCode} acknowledged command (commandComplete=0)`);

            const pathObject = command.path;

            // Convert legacy path to new format
            const newPath = [];
            for (let i = 1; i <= pathObject.totalStep; i++) {
                const stepString = pathObject[`step${i}`];
                if (stepString) {
                    const stepData = parseStepString(stepString);
                    newPath.push(stepData);
                }
            }

            if (newPath.length > 0) {
                publishEvent('shuttle-task-started', shuttle.no, { pathLength: newPath.length, startNode: newPath[0].qrCode });

                shuttle.path = newPath;
                shuttle.onArrival = command.onArrival;
                shuttle.taskInfo = command.taskInfo;
                shuttle.currentPathIndex = 0;
                shuttle.currentStep = 0;
                shuttle.qrCode = newPath[0].qrCode;
                shuttle.shuttleStatus = SHUTTLE_STATUS.NORMAL_SPEED;
                // commandComplete already set to IN_PROGRESS above for immediate ACK
                shuttle.lastMoveTimestamp = Date.now();
            }

        } else {
            console.warn(`[Simulator] Shuttle ${shuttleCode} received invalid message format.`, command);
        }
    } catch (e) {
        console.error(`[Simulator] Failed to parse message for shuttle ${shuttleCode}:`, e);
    }
});

client.on('error', (err) => {
    console.error('[Simulator] Connection error:', err);
    client.end();
});