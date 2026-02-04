class PathfindingService {
    constructor(graph) {
        this.graph = graph;
    }

    findPath(startId, endId) {
        const startNode = this.graph.getNode(startId);
        const endNode = this.graph.getNode(endId);

        if (!startNode || !endNode) {
            throw new Error('Start or end node not found');
        }

        const openSet = new Set([startId]);
        const closedSet = new Set();
        const gScore = new Map([[startId, 0]]);
        const fScore = new Map([[startId, this.heuristic(startNode, endNode)]]);
        const cameFrom = new Map();

        while (openSet.size > 0) {
            const current = this.getLowestFScore(openSet, fScore);

            if (current === endId) {
                return this.reconstructPath(cameFrom, current);
            }

            openSet.delete(current);
            closedSet.add(current);

            const currentNode = this.graph.getNode(current);
            this.processNeighbors(
                currentNode,
                endNode,
                openSet,
                closedSet,
                gScore,
                fScore,
                cameFrom
            );
        }

        return null;
    }

    processNeighbors(currentNode, endNode, openSet, closedSet, gScore, fScore, cameFrom) {
        currentNode.neighbors.forEach(({ nodeId, distance }) => {
            if (closedSet.has(nodeId)) {
                return;
            }

            const tentativeGScore = gScore.get(currentNode.id) + distance;

            if (!openSet.has(nodeId)) {
                openSet.add(nodeId);
            } else if (tentativeGScore >= gScore.get(nodeId)) {
                return;
            }

            cameFrom.set(nodeId, currentNode.id);
            gScore.set(nodeId, tentativeGScore);

            const neighborNode = this.graph.getNode(nodeId);
            const h = this.heuristic(neighborNode, endNode);
            fScore.set(nodeId, tentativeGScore + h);
        });
    }

    heuristic(nodeA, nodeB) {
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

module.exports = PathfindingService;
