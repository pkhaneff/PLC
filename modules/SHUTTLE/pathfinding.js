const { logger } = require('../../logger/logger');
const cellService = require('./cellService');
const { TASK_ACTIONS } = require('../../config/shuttle.config');

// Old findShortestPath removed. New implementation finds path between two QR codes.

/**
 * Converts path cells to mission step format with task actions
 * @param {Array} pathCells - Array of cell objects with coordinates and QR codes
 * @param {Object} options - Optional configuration
 * @param {number} options.lastStepAction - Task action for the last step (default: NO_ACTION)
 * @param {Array} options.stepActions - Array of specific actions for each step
 * @returns {Object} Mission format: { totalStep, step1: "QRCODE>direction:action", step2: ... }
 */
function convertPathToStepFormat(pathCells, options = {}) {
  if (!pathCells || pathCells.length === 0) {
    return null;
  }

  const {
    lastStepAction = TASK_ACTIONS.NO_ACTION,
    stepActions = []
  } = options;

  const result = {
    totalStep: pathCells.length
  };

  pathCells.forEach((cell, index) => {
    let direction = 1;

    if (index > 0) {
      const prevCell = pathCells[index - 1];
      direction = calculateDirection(prevCell, cell);
    }

    // Determine action for this step
    let action = TASK_ACTIONS.NO_ACTION;
    if (stepActions[index] !== undefined) {
      action = stepActions[index];
    } else if (index === pathCells.length - 1) {
      action = lastStepAction; // Last step gets special action
    }

    result[`step${index + 1}`] = `${cell.qr_code}>${direction}:${action}`;
  });

  return result;
}

function calculateDirection(fromCell, toCell) {
  const colDiff = toCell.col - fromCell.col;
  const rowDiff = toCell.row - fromCell.row;

  if (rowDiff < 0) return 1;
  if (colDiff > 0) return 2;
  if (rowDiff > 0) return 3;
  if (colDiff < 0) return 4;

  return 1;
}

// Heuristic function (Manhattan distance)
function heuristic(cell1, cell2) {
  return Math.abs(cell1.col - cell2.col) + Math.abs(cell1.row - cell2.row);
}

async function findShortestPathByCellAsync(startCell, endCell, floorId, options = {}) {
  const openSet = new Set(); // Stores QR codes of cells to evaluate
  const openSetQueue = []; // Priority queue for openSet (stores { fScore, qrCode })

  const cameFrom = new Map(); // Maps QR code to the QR code of the cell preceding it on the cheapest path

  const gScore = new Map(); // Cost from start to current cell
  gScore.set(startCell.qr_code, 0);

  const fScore = new Map(); // gScore + heuristic cost
  fScore.set(startCell.qr_code, heuristic(startCell, endCell));

  // Add start cell to open set
  openSet.add(startCell.qr_code);
  openSetQueue.push({ fScore: fScore.get(startCell.qr_code), qrCode: startCell.qr_code, cell: startCell });

  const currentCellMap = new Map(); // Map qr_code to cell object
  currentCellMap.set(startCell.qr_code, startCell);

  const closedSet = new Set(); // Track processed nodes to prevent revisiting

  while (openSetQueue.length > 0) {
    // Sort queue to get element with lowest fScore (simple priority queue)
    openSetQueue.sort((a, b) => a.fScore - b.fScore);
    const { qrCode: currentQrCode, cell: currentCell } = openSetQueue.shift();

    openSet.delete(currentQrCode);

    // Skip if already processed (prevents circular references)
    if (closedSet.has(currentQrCode)) {
      continue;
    }

    closedSet.add(currentQrCode); // Mark as processed

    if (currentQrCode === endCell.qr_code) {
      // Reconstruct path with circular reference detection
      const path = [];
      const visited = new Set(); // Track visited nodes to detect cycles
      let tempQr = currentQrCode;
      let reconstructIter = 0;

      while (cameFrom.has(tempQr)) {
        reconstructIter++;

        // Detect circular reference (should not happen with closedSet, but keep as safety)
        if (visited.has(tempQr)) {
          logger.error(`[Pathfinding] CIRCULAR REFERENCE detected at node ${tempQr}!`);
          logger.error('[Pathfinding] cameFrom chain:', Array.from(visited));
          return null; // Return null instead of invalid path
        }

        // Safety limit
        if (reconstructIter > 1000) {
          logger.error('[Pathfinding] Path reconstruction exceeded 1000 iterations!');
          return null;
        }

        visited.add(tempQr);
        const cellObj = currentCellMap.get(tempQr);

        if (!cellObj) {
          logger.error(`[Pathfinding] Cell object not found for QR: ${tempQr}`);
          return null;
        }

        path.unshift(cellObj); // Add cell object
        tempQr = cameFrom.get(tempQr);
      }

      // Add start cell (only if not already in path)
      if (path.length === 0 || path[0].qr_code !== startCell.qr_code) {
        path.unshift(startCell);
      }

      return path;
    }

    const { neighbors: validNeighbors, neighborCosts } = await getValidNeighborsFromDB(currentCell, floorId, endCell.qr_code, options);

    for (const neighborData of validNeighbors) {
      const neighborCell = neighborData.cell;
      const cost = neighborData.cost; // Cost to move to this neighbor

      // Skip if neighbor already processed
      if (closedSet.has(neighborCell.qr_code)) {
        continue;
      }

      // d(current, neighbor) is the cost to move from current to neighbor
      const tentativeGScore = gScore.get(currentQrCode) + cost;

      if (tentativeGScore < (gScore.get(neighborCell.qr_code) || Infinity)) {
        cameFrom.set(neighborCell.qr_code, currentQrCode);
        gScore.set(neighborCell.qr_code, tentativeGScore);
        fScore.set(neighborCell.qr_code, tentativeGScore + heuristic(neighborCell, endCell));
        currentCellMap.set(neighborCell.qr_code, neighborCell); // Store cell object

        if (!openSet.has(neighborCell.qr_code)) {
          openSet.add(neighborCell.qr_code);
          openSetQueue.push({ fScore: fScore.get(neighborCell.qr_code), qrCode: neighborCell.qr_code, cell: neighborCell });
        }
      }
    }
  }

  return null; // No path found
}


async function getValidNeighborsFromDB(cell, floorId, targetQr = null, options = {}) {
  const { col, row, direction_type, is_block } = cell;
  const neighbors = [];
  const results = {
    neighbors: [], // Array of { cell, cost }
    neighborCosts: {} // Map qr_code to cost
  };

  if (is_block === 1) {
    return results;
  }

  const directions = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0]
  };

  const allowedDirections = parseDirectionType(direction_type);
  const isShuttleCarrying = options.isCarrying || false;
  const trafficData = options.trafficData || []; // Array of { shuttleId, path: [{qrCode, direction}], ... }

  for (const dir of allowedDirections) {
    const [deltaCol, deltaRow] = directions[dir];
    const newCol = col + deltaCol;
    const newRow = row + deltaRow;

    const neighborCell = await cellService.getCellByPosition(newCol, newRow, floorId);

    if (neighborCell && neighborCell.is_block !== 1) {
      // Logic for blocking based on isShuttleCarrying and is_has_box
      if (isShuttleCarrying && neighborCell.is_has_box === 1 && neighborCell.qr_code !== targetQr) {
        continue; // Block if loaded shuttle and neighbor has box (not target)
      }

      const oppositeDir = getOppositeDirection(dir);
      const neighborAllowedDirections = parseDirectionType(neighborCell.direction_type);

      if (neighborAllowedDirections.includes(oppositeDir)) {
        let cost = 1; // Default cost
        let trafficPenalty = 0;
        let corridorPenalty = 0;

        // --- Apply Enhanced Traffic Penalty (Pillar 2) ---
        // Check if moving to this neighbor would go against traffic flow
        for (const trafficShuttle of trafficData) {
          // Find if this neighbor is on another shuttle's path
          const pathIndex = trafficShuttle.path.findIndex(p => p.qrCode === neighborCell.qr_code);

          if (pathIndex !== -1) { // Neighbor cell is on another shuttle's path
            // Check if our intended direction (dir) is opposite to the other shuttle's next intended direction
            const trafficDirection = trafficShuttle.path[pathIndex]?.direction;
            const otherShuttleMetadata = trafficShuttle.metadata || {};

            // Calculate base penalty based on direction conflict
            let basePenalty = 0;
            if (trafficDirection && getOppositeDirection(dir) === trafficDirection) {
              // Going directly against traffic - HIGH penalty
              basePenalty = 150;

              // Extra penalty if other shuttle is carrying cargo (higher priority)
              if (otherShuttleMetadata.isCarrying) {
                basePenalty += 50; // Total 200 against carrying shuttle
              }

              // Extra penalty if we're empty and they're carrying (we should yield)
              if (!isShuttleCarrying && otherShuttleMetadata.isCarrying) {
                basePenalty += 30; // Total up to 230
              }

              logger.debug(`[Pathfinding] High penalty for ${neighborCell.qr_code}: going ${dir} against ${trafficShuttle.shuttleId}'s direction ${trafficDirection} (carrying: ${otherShuttleMetadata.isCarrying})`);
            } else if (trafficDirection && dir === trafficDirection) {
              // Going with traffic - small congestion penalty
              basePenalty = isShuttleCarrying ? 8 : 5; // Carrying shuttles prefer less congestion
            } else {
              // Crossing traffic - moderate penalty
              basePenalty = 15;

              // Higher penalty if other shuttle is carrying
              if (otherShuttleMetadata.isCarrying) {
                basePenalty += 10; // Total 25
              }
            }

            trafficPenalty += basePenalty;
          }
        }

        // Apply traffic penalty
        cost += trafficPenalty;
        // --- End Enhanced Traffic Penalty ---

        // --- Apply Traffic Flow Corridor Penalty (Pillar 2) ---
        // Check if this neighbor is in a high-traffic corridor
        // Convert string direction to numeric direction for corridor check
        const directionMap = { 'up': 1, 'right': 2, 'down': 3, 'left': 4 };
        const numericDir = directionMap[dir];

        if (numericDir && options.corridors) {
          const corridor = options.corridors.get(neighborCell.qr_code);
          if (corridor) {
            const oppositeNumericDir = getOppositeDirection(numericDir);

            if (corridor.dominantDirection === oppositeNumericDir) {
              // Going against dominant corridor flow - VERY HIGH penalty
              corridorPenalty = corridor.isHighTraffic ? 250 : 180;
              logger.debug(`[Pathfinding] Corridor penalty for ${neighborCell.qr_code}: going against ${corridor.shuttleCount}-shuttle corridor (dominant dir: ${corridor.dominantDirection})`);
            } else if (corridor.dominantDirection === numericDir) {
              // Going with corridor flow - small penalty for congestion
              corridorPenalty = corridor.isHighTraffic ? 25 : 12;
            } else {
              // Crossing corridor - moderate penalty
              corridorPenalty = corridor.isHighTraffic ? 60 : 35;
            }

            cost += corridorPenalty;
          }
        }
        // --- End Corridor Penalty ---

        results.neighbors.push({ cell: neighborCell, cost: cost });
        results.neighborCosts[neighborCell.qr_code] = cost;
      }
    }
  }

  return results;
}

function parseDirectionType(directionType) {
  if (!directionType) return [];

  const directions = [];

  // Support both "up,down,left,right" and "up_down_and_left" formats
  const normalized = directionType.toLowerCase().replace(/_and_/g, '_').replace(/_/g, ',');

  if (normalized.includes('up')) directions.push('up');
  if (normalized.includes('down')) directions.push('down');
  if (normalized.includes('left')) directions.push('left');
  if (normalized.includes('right')) directions.push('right');

  return directions;
}

function getOppositeDirection(direction) {
  // Handle numeric directions (1=up, 2=right, 3=down, 4=left)
  if (typeof direction === 'number') {
    const numericOpposites = { 1: 3, 2: 4, 3: 1, 4: 2 };
    return numericOpposites[direction] || direction;
  }

  // Handle string directions
  const opposites = {
    up: 'down',
    down: 'up',
    left: 'right',
    right: 'left'
  };

  return opposites[direction];
}

/**
 * Find shortest path between two QR codes (both start and end are QR codes).
 * This is the primary pathfinding function.
 * 
 * @param {string} startQrCode - Starting QR code
 * @param {string} endQrCode - Ending QR code
 * @param {number} floorId - Floor ID
 * @param {object} options - Pathfinding options (avoid, avoidNames)
 * @returns {Promise<object|null>} Path object or null
 */
async function findShortestPath(startQrCode, endQrCode, floorId, options = {}) {
  // --- New Logic: Automatic Dynamic Obstacle Avoidance ---
  // If 'avoid' is NOT provided at all (undefined), we auto-inject from Redis.
  // If 'avoid' is provided (even as []), we respect the caller's choice.
  if (options.avoid === undefined) {
    try {
      // Lazy load to prevent circular dependency
      const NodeOccupationService = require('./NodeOccupationService');
      const occupiedMap = await NodeOccupationService.getAllOccupiedNodes();

      const dynamicAvoidList = Object.keys(occupiedMap).filter(qr =>
        qr !== startQrCode && // Don't avoid our own start
        qr !== endQrCode      // Don't avoid our destination
      );

      options = { ...options, avoid: dynamicAvoidList };
    } catch (err) {
      logger.error('[Pathfinding] Error in auto-injection:', err);
      // Fallback: Proceed without dynamic avoid if service fails
    }
  }
  // --- End New Logic ---

  // --- Pillar 2: Fetch Traffic Flow Corridors ---
  // If corridors not explicitly provided, fetch them for traffic-aware pathfinding
  if (options.corridors === undefined) {
    try {
      const PathCacheService = require('./PathCacheService');
      options.corridors = await PathCacheService.detectTrafficFlowCorridors();
      logger.debug(`[Pathfinding] Detected ${options.corridors.size} traffic corridors for pathfinding`);
    } catch (err) {
      logger.error('[Pathfinding] Error fetching traffic corridors:', err);
      options.corridors = new Map(); // Fallback to empty map
    }
  }
  // --- End Pillar 2 ---

  const startCell = await cellService.getCellByQrCode(startQrCode, floorId);
  const endCell = await cellService.getCellByQrCode(endQrCode, floorId);

  if (!startCell) {
    logger.error(`[Pathfinding] Start cell ${startQrCode} not found on floor ${floorId}`);
    throw new Error(`Pathfinding start cell with QR code '${startQrCode}' not found on floor ${floorId}.`);
  }
  if (!endCell) {
    logger.error(`[Pathfinding] End cell ${endQrCode} not found on floor ${floorId}`);
    throw new Error(`Pathfinding end cell with QR code '${endQrCode}' not found on floor ${floorId}.`);
  }

  const pathCells = await findShortestPathByCellAsync(startCell, endCell, floorId, options);

  if (!pathCells) {
    logger.warn(`[Pathfinding] FAILED to find path from ${startQrCode} to ${endQrCode} on floor ${floorId}.`);
  }

  return convertPathToStepFormat(pathCells, options);
}

/**
 * Legacy: Find shortest path where start is QR code and end is Name.
 * @deprecated Use findShortestPath with QR codes instead.
 */
async function findShortestPathLegacy(startQrCode, endName, floorId, options = {}) {
  const startCell = await cellService.getCellByQrCode(startQrCode, floorId);
  const endCell = await cellService.getCellByName(endName, floorId);

  if (!startCell) {
    throw new Error(`Pathfinding start cell with QR code '${startQrCode}' not found on floor ${floorId}.`);
  }
  if (!endCell) {
    throw new Error(`Pathfinding end cell with name '${endName}' not found on floor ${floorId}.`);
  }

  const pathCells = await findShortestPathByCellAsync(startCell, endCell, floorId, options);

  return convertPathToStepFormat(pathCells, options);
}

// ... helper functions ...

async function findShortestPathByQrCode(startQrCode, endQrCode, floorId, options = {}) {
  return findShortestPath(startQrCode, endQrCode, floorId, options);
}


module.exports = {
  findShortestPath,
  findShortestPathLegacy,
  findShortestPathByQrCode, // Export for backward compatibility
  convertPathToStepFormat,
  parseDirectionType,
  getValidNeighborsFromDB
};
