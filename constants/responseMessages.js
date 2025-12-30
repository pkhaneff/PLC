
const SHUTTLE_MESSAGES = {
    PROCESSING: 'Shuttle đang được xử lý',
    COMPLETED: 'Shuttle đã đến đích',
    CONTINUE: 'Có thể tiếp tục di chuyển',
    REROUTE_BRIDGE: (bridgeNode) => `Sử dụng bridge node: ${bridgeNode}`,
    WAITING_FOR: (shuttleId) => `Đợi shuttle ${shuttleId} đi qua`,
    MOVING_TO: (node) => `Shuttle di chuyển đến ${node}`,
    CONFLICT_DETECTED: (conflictWith, conflictNode) =>
        `Phát hiện conflict với ${conflictWith} tại node ${conflictNode}`,

    MISSING_PARAMS: (params) => `Missing required parameters: ${params}`,
    ALREADY_REGISTERED: (shuttleId) => `Shuttle ${shuttleId} is already registered and active`,
    NOT_FOUND: (shuttleId) => `Shuttle ${shuttleId} not found. Please register first.`,
    NO_PATH_FOUND: (start, end) => `Không tìm thấy đường đi từ ${start} đến ${end}`,
    UNKNOWN_CONFLICT_ERROR: 'Unknown conflict resolution error'
};

const HTTP_STATUS = {
    OK: 200,
    BAD_REQUEST: 400,
    NOT_FOUND: 404,
    INTERNAL_SERVER_ERROR: 500
};

const ACTIONS = {
    CONTINUE: 'continue',
    WAIT: 'wait',
    REROUTE: 'reroute',
    BRIDGE: 'bridge',
    MOVING: 'moving',
    COMPLETED: 'completed'
};

const STATUSES = {
    PROCESSING: 'processing',
    RUNNING: 'running',
    WAITING: 'waiting',
    REROUTING: 'rerouting',
    COMPLETED: 'completed'
};

module.exports = {
    SHUTTLE_MESSAGES,
    HTTP_STATUS,
    ACTIONS,
    STATUSES
};
