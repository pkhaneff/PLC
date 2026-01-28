// Shuttle Task Actions
const TASK_ACTIONS = {
  NO_ACTION: 10,
  PICK_UP: 11, // Pick up (Lift pallet)
  DROP_OFF: 12, // Drop off (Lower pallet)
  SLOW_SPEED_1: 13, // Slow speed Level 1 (Slow)
  SLOW_SPEED_2: 14, // Slow speed Level 2 (Very slow)
  STOP_AT_NODE: 15, // Stop at the final node
  FAST_SPEED: 16, // Move at 1/2 fast speed
};

// Shuttle Status Values
const SHUTTLE_STATUS = {
  ERROR: 1,
  PICKING: 2, // Picking up cargo
  DROPPING: 3, // Dropping off cargo
  WHEELS_UP: 4, // Wheels lifted
  WHEELS_DOWN: 5, // Wheels lowered
  SLOW_SPEED: 6,
  NORMAL_SPEED: 7,
  IDLE: 8,
  WAITING: 9,
};

// MQTT Topics
const MQTT_TOPICS = {
  INFORMATION: 'shuttle/information', // shuttle/information/{code}
  HANDLE: 'shuttle/handle', // shuttle/handle/{code}
  EVENTS: 'shuttle/events', // shuttle/events
};

// Mission Retry Configuration
const MISSION_CONFIG = {
  RETRY_INTERVAL: 500, // 500ms between retries
  RETRY_TIMEOUT: 30000, // 30 seconds timeout
  PUBLISH_INTERVAL: 300, // 300ms publish interval for shuttle information
};

module.exports = {
  TASK_ACTIONS,
  SHUTTLE_STATUS,
  MQTT_TOPICS,
  MISSION_CONFIG,

  warehouses: {
    39: {
      pickupNodeQr: 'X2222Y2222', // S1 - pickup point
      safetyNodeExit: 'X5555Y5555', // Safety exit node - release lock when shuttle passes here with cargo
    },
  },

  // ============================================================
  // 3-PILLAR INTELLIGENT TRAFFIC MANAGEMENT SYSTEM
  // ============================================================

  // PILLAR 1: TRAFFIC CENTER (PathCacheService)
  pathCache: {
    defaultTTL: 600, // 10 minutes
    cleanupInterval: 30000, // 30 seconds
    corridor: {
      minShuttleCount: 2,
      dominanceRatio: 0.7, // 70% traffic in same direction
      highTrafficThreshold: 3,
    },
  },

  // PILLAR 2: TRAFFIC-AWARE A* PATHFINDING
  pathfinding: {
    trafficPenalty: {
      againstTraffic: {
        base: 150,
        vsCarrying: 50,
        emptyVsCarrying: 30,
      },
      withTraffic: {
        carrying: 8,
        empty: 5,
      },
      crossingTraffic: {
        base: 15,
        vsCarrying: 10,
      },
    },
    corridorPenalty: {
      againstCorridor: {
        normal: 180,
        highTraffic: 250,
      },
      withCorridor: {
        normal: 12,
        highTraffic: 25,
      },
      crossingCorridor: {
        normal: 35,
        highTraffic: 60,
      },
    },
  },

  // PILLAR 3: MULTI-TIER CONFLICT RESOLUTION
  conflictResolution: {
    tier1: {
      carrying: 140, // Max 140% path increase
      empty: 200,
    },
    tier2: {
      bonusPerRetry: 50, // +50% per retry
      maxRetries: 3,
    },
    tier3: {
      bonusInterval: 15, // seconds
      bonusAmount: 50, // percentage
      emergencyTimeout: 45, // seconds
      maxCostCap: 500,
    },
    waitStrategy: {
      initialWaitTime: 5000, // 5s
      maxWaitTime: 45000, // 45s
      retryInterval: 15000, // 15s
    },
  },

  // Priority calculation weights
  priority: {
    weights: {
      cargoStatus: 1000,
      taskAge: 100,
      pathProgress: 50,
      retryCount: 25,
    },
    cargoStatusPriority: {
      carrying: 1000,
      empty: 0,
    },
  },

  // Monitoring & logging
  monitoring: {
    enableTrafficLogging: true,
    enableCorridorLogging: true,
    enableTierLogging: true,
    collectStats: true,
  },
};
