const PathfindingService = require('../services/pathfinding.service');
const PathReservationService = require('../reservation/PathReservationService');
const AMRLogger = require('../utils/AMRLogger');

class PathfinderWithReservations {
    constructor(graph) {
        this.pathfinder = new PathfindingService(graph);
        this.graph = graph;
    }

    async findPath(startId, endId, amrId) {
        try {
            const basePath = this.pathfinder.findPath(startId, endId);

            if (!basePath) {
                AMRLogger.debug('Pathfinder', 'No path found', { startId, endId });
                return null;
            }

            const isAvailable = await PathReservationService.isPathAvailable(basePath, amrId);

            if (isAvailable) {
                return basePath;
            }

            AMRLogger.debug('Pathfinder', 'Path blocked, checking alternatives', {
                amrId,
                pathLength: basePath.length
            });

            return await this.findAlternativePath(startId, endId, amrId, basePath);
        } catch (error) {
            AMRLogger.error('Pathfinder', 'Failed to find path', error);
            return null;
        }
    }

    async findAlternativePath(startId, endId, amrId, blockedPath) {
        const conflicts = await PathReservationService.getConflictingNodes(blockedPath, amrId);
        const nodesToAvoid = conflicts.map(c => c.nodeId);

        const altPath = this.findPathAvoidingNodes(startId, endId, nodesToAvoid);

        if (altPath) {
            const isAvailable = await PathReservationService.isPathAvailable(altPath, amrId);
            if (isAvailable) {
                AMRLogger.debug('Pathfinder', 'Alternative path found', {
                    amrId,
                    pathLength: altPath.length
                });
                return altPath;
            }
        }

        return null;
    }

    findPathAvoidingNodes(startId, endId, nodesToAvoid) {
        const openSet = new Set([startId]);
        const closedSet = new Set(nodesToAvoid);
        const gScore = new Map([[startId, 0]]);
        const fScore = new Map([[startId, this.heuristic(startId, endId)]]);
        const cameFrom = new Map();

        while (openSet.size > 0) {
            const current = this.getLowestFScore(openSet, fScore);

            if (current === endId) {
                return this.reconstructPath(cameFrom, current);
            }

            openSet.delete(current);
            closedSet.add(current);

            const currentNode = this.graph.getNode(current);
            if (!currentNode) continue;

            currentNode.neighbors.forEach(({ nodeId, distance }) => {
                if (closedSet.has(nodeId)) return;

                const tentativeGScore = gScore.get(current) + distance;

                if (!openSet.has(nodeId)) {
                    openSet.add(nodeId);
                } else if (tentativeGScore >= gScore.get(nodeId)) {
                    return;
                }

                cameFrom.set(nodeId, current);
                gScore.set(nodeId, tentativeGScore);
                fScore.set(nodeId, tentativeGScore + this.heuristic(nodeId, endId));
            });
        }

        return null;
    }

    heuristic(nodeIdA, nodeIdB) {
        const nodeA = this.graph.getNode(nodeIdA);
        const nodeB = this.graph.getNode(nodeIdB);

        if (!nodeA || !nodeB) return Infinity;

        return nodeA.getDistance(nodeB);
    }

    getLowestFScore(openSet, fScore) {
        let lowest = null;
        let lowestScore = Infinity;

        openSet.forEach(nodeId => {
            const score = fScore.get(nodeId) || Infinity;
            if (score < lowestScore) {
                lowestScore = score;
                lowest = nodeId;
            }
        });

        return lowest;
    }

    reconstructPath(cameFrom, current) {
        const path = [current];

        while (cameFrom.has(current)) {
            current = cameFrom.get(current);
            path.unshift(current);
        }

        return path;
    }
}

module.exports = PathfinderWithReservations;
