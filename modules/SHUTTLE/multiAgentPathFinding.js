const { logger } = require('../../logger/logger');
const shuttleManager = require('./shuttleManager');
const cellService = require('./cellService');

class MultiAgentPathFinding {
    constructor() {
        logger.info('[MAPF] Multi-Agent Path Finding initialized with database');
    }

    async findPath(startNameOrQr, endNameOrQr, excludeBlockedNodes = false) {
        const { byQr, byName } = await this.buildCellMaps();

        let startCell = byName.get(startNameOrQr) || byQr.get(startNameOrQr);
        let endCell = byName.get(endNameOrQr) || byQr.get(endNameOrQr);

        if (!startCell) {
            throw new Error(`Start node ${startNameOrQr} not found`);
        }

        if (!endCell) {
            throw new Error(`End node ${endNameOrQr} not found`);
        }

        const queue = [[startCell, [startCell]]];
        const visited = new Set([startCell.qr_code]);

        while (queue.length > 0) {
            const [currentCell, path] = queue.shift();

            if (currentCell.qr_code === endCell.qr_code) {
                return path.map(c => c.qr_code);
            }

            const neighbors = await this.getValidNeighbors(currentCell.id);

            for (const neighbor of neighbors) {
                if (!visited.has(neighbor.qr_code)) {
                    if (excludeBlockedNodes && await shuttleManager.isNodeBlocked(neighbor.qr_code)) {
                        continue;
                    }

                    visited.add(neighbor.qr_code);
                    queue.push([neighbor, [...path, neighbor]]);
                }
            }
        }

        return null;
    }

    async getValidNeighbors(cellId) {
        // TODO: Implement based on cell relationships in database
        // For now return empty array - needs cell_connections table
        return [];
    }

    async buildCellMaps() {
        const cells = await cellService.getMapData();
        const byQr = new Map();
        const byName = new Map();
        const byId = new Map();

        cells.forEach(cell => {
            byQr.set(cell.qr_code, cell);
            byName.set(cell.name, cell);
            byId.set(cell.id, cell);
        });

        return { byQr, byName, byId, cells };
    }

    async detectConflict(shuttleId) {
        const shuttle = await shuttleManager.getShuttle(shuttleId);

        if (!shuttle) {
            throw new Error(`Shuttle ${shuttleId} not found`);
        }

        const currentIndex = shuttle.current_step_index;
        const path = shuttle.path;

        if (currentIndex >= path.length - 1) {
            return { hasConflict: false };
        }

        const currentNode = path[currentIndex];
        const nextNode = path[currentIndex + 1];

        const otherShuttles = await shuttleManager.getActiveShuttles();
        const filtered = otherShuttles.filter(s => s.id !== shuttleId);

        for (const other of filtered) {
            if (other.reservedNodes.includes(nextNode)) {
                logger.debug(`[MAPF] Node conflict: ${shuttleId} vs ${other.id} at node ${nextNode}`);
                return {
                    hasConflict: true,
                    conflictWith: other.id,
                    conflictNode: nextNode,
                    conflictType: 'node'
                };
            }

            const otherCurrentIndex = other.current_step_index;
            if (otherCurrentIndex < other.path.length - 1) {
                const otherCurrent = other.path[otherCurrentIndex];
                const otherNext = other.path[otherCurrentIndex + 1];

                if (currentNode === otherNext && nextNode === otherCurrent) {
                    logger.debug(`[MAPF] Edge conflict: ${shuttleId} vs ${other.id}`);
                    return {
                        hasConflict: true,
                        conflictWith: other.id,
                        conflictNode: nextNode,
                        conflictType: 'edge'
                    };
                }
            }
        }

        return { hasConflict: false };
    }

    async resolveConflict(shuttleId, conflict) {
        const shuttle = await shuttleManager.getShuttle(shuttleId);
        const otherShuttle = await shuttleManager.getShuttle(conflict.conflictWith);

        if (!shuttle || !otherShuttle) {
            return { action: 'error', message: 'Shuttle not found' };
        }

        const shuttlePriority = shuttle.registered_at;
        const otherPriority = otherShuttle.registered_at;

        const hasHigherPriority = shuttlePriority < otherPriority;

        logger.debug(`[MAPF] Conflict resolution: ${shuttleId} vs ${conflict.conflictWith}, hasHigher=${hasHigherPriority}`);

        if (hasHigherPriority) {
            return {
                action: 'continue',
                message: `Shuttle ${shuttleId} has higher priority`
            };
        } else {
            return {
                action: 'wait',
                conflictWith: conflict.conflictWith,
                message: `Waiting for ${conflict.conflictWith}`
            };
        }
    }

    async findReroutePath(currentQr, targetQr) {
        const reroutePath = await this.findPath(currentQr, targetQr, true);

        if (!reroutePath) {
            logger.warn(`[MAPF] No reroute path found from ${currentQr} to ${targetQr}`);
            return null;
        }

        logger.info(`[MAPF] Reroute path found: ${reroutePath.length} steps`);
        return reroutePath;
    }

    async shouldApplyBackupReroute(shuttleId) {
        const shuttle = await shuttleManager.getShuttle(shuttleId);

        if (!shuttle || !shuttle.waiting_since) {
            return false;
        }

        const waitTime = Date.now() - shuttle.waiting_since;
        const WAIT_THRESHOLD = 10000;

        return waitTime >= WAIT_THRESHOLD;
    }

    calculateRerouteCost(shuttle, newPath) {
        const originalPath = shuttle.path;
        const originalLength = originalPath.length;

        const newPathLength = newPath.length;
        const maxAcceptable = Math.ceil(originalLength * 1.5);

        const isAcceptable = newPathLength <= maxAcceptable;

        logger.debug(`[MAPF] Reroute cost: original=${originalLength}, new=${newPathLength}, acceptable=${isAcceptable}`);

        return {
            isAcceptable,
            originalLength,
            newPathLength,
            maxAcceptable,
            increase: newPathLength - originalLength,
            increasePercent: ((newPathLength - originalLength) / originalLength * 100).toFixed(2)
        };
    }
}

module.exports = new MultiAgentPathFinding();
