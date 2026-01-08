const cellService = require('./cellService');

async function findShortestPath(startQrCode, endName, floorId) {
  // The starting point is a QR code from the shuttle, the end point is a logical name from the task.
  const startCell = await cellService.getCellByQrCode(startQrCode, floorId);
  const endCell = await cellService.getCellByName(endName, floorId);

  if (!startCell) {
    throw new Error(`Pathfinding start cell with QR code '${startQrCode}' not found on floor ${floorId}.`);
  }
  if (!endCell) {
    throw new Error(`Pathfinding end cell with name '${endName}' not found on floor ${floorId}.`);
  }

  const pathCells = await findShortestPathByCellAsync(startCell, endCell, floorId);

  return convertPathToStepFormat(pathCells);
}

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

    result[`step${index + 1}`] = `${cell.name}>${direction}`;
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

async function findShortestPathByCellAsync(startCell, endCell, floorId) {
  const queue = [[startCell, [startCell]]];
  const visited = new Set([startCell.name]);

  while (queue.length > 0) {
    const [currentCell, path] = queue.shift();

    if (currentCell.name === endCell.name) {
      return path;
    }

    const neighbors = await getValidNeighborsFromDB(currentCell, floorId);

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor.name)) {
        visited.add(neighbor.name);
        queue.push([neighbor, [...path, neighbor]]);
      }
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


module.exports = {
  findShortestPath,
  convertPathToStepFormat,
  parseDirectionType,
  getValidNeighborsFromDB
};
