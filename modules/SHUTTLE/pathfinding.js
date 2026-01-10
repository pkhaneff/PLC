const cellService = require('./cellService');

// Old findShortestPath removed. New implementation finds path between two QR codes.

function convertPathToStepFormat(pathCells) {
  if (!pathCells || pathCells.length === 0) {
    return null;
  }

  const result = {
    totalStep: pathCells.length
  };

  pathCells.forEach((cell, index) => {
    let direction = 1;

    if (index > 0) {
      const prevCell = pathCells[index - 1];
      direction = calculateDirection(prevCell, cell);
    }

    result[`step${index + 1}`] = `${cell.qr_code}>${direction}`;
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

async function findShortestPathByCellAsync(startCell, endCell, floorId, options = {}) {
  const queue = [[startCell, [startCell]]];
  const visited = new Set([startCell.qr_code]);

  // Build set of nodes to avoid
  const avoidSet = new Set();
  if (options.avoid) {
    options.avoid.forEach(qr => avoidSet.add(qr));
  }
  if (options.avoidNames) {
    options.avoidNames.forEach(name => avoidSet.add(name));
  }

  while (queue.length > 0) {
    const [currentCell, path] = queue.shift();

    if (currentCell.qr_code === endCell.qr_code) {
      return path;
    }

    const neighbors = await getValidNeighborsFromDB(currentCell, floorId);

    for (const neighbor of neighbors) {
      // Skip if already visited (use qr_code for visited tracking)
      if (visited.has(neighbor.qr_code)) continue;

      // Skip if in avoid list (check both name and qr_code for backward compatibility)
      if (avoidSet.has(neighbor.name) || avoidSet.has(neighbor.qr_code)) {
        continue;
      }

      visited.add(neighbor.qr_code);
      queue.push([neighbor, [...path, neighbor]]);
    }
  }

  return null;
}

async function getValidNeighborsFromDB(cell, floorId) {
  const { col, row, direction_type, is_block } = cell;
  const neighbors = [];

  if (is_block === 1) {
    return neighbors;
  }

  const directions = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0]
  };

  const allowedDirections = parseDirectionType(direction_type);

  for (const dir of allowedDirections) {
    const [deltaCol, deltaRow] = directions[dir];
    const newCol = col + deltaCol;
    const newRow = row + deltaRow;

    // Query từ DB thay vì Map.get()
    const neighborCell = await cellService.getCellByPosition(newCol, newRow, floorId);

    if (neighborCell && neighborCell.is_block !== 1) {
      const oppositeDir = getOppositeDirection(dir);
      const neighborAllowedDirections = parseDirectionType(neighborCell.direction_type);

      if (neighborAllowedDirections.includes(oppositeDir)) {
        neighbors.push(neighborCell);
      }
    }
  }

  return neighbors;
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
  const startCell = await cellService.getCellByQrCode(startQrCode, floorId);
  const endCell = await cellService.getCellByQrCode(endQrCode, floorId);

  if (!startCell) {
    throw new Error(`Pathfinding start cell with QR code '${startQrCode}' not found on floor ${floorId}.`);
  }
  if (!endCell) {
    throw new Error(`Pathfinding end cell with QR code '${endQrCode}' not found on floor ${floorId}.`);
  }

  const pathCells = await findShortestPathByCellAsync(startCell, endCell, floorId, options);

  return convertPathToStepFormat(pathCells);
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

  return convertPathToStepFormat(pathCells);
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
