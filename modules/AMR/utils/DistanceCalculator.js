class DistanceCalculator {
    static manhattan(node1, node2) {
        if (!node1 || !node2) return Infinity;

        const dx = Math.abs(node1.x - node2.x);
        const dy = Math.abs(node1.y - node2.y);

        return dx + dy;
    }

    static euclidean(node1, node2) {
        if (!node1 || !node2) return Infinity;

        const dx = node1.x - node2.x;
        const dy = node1.y - node2.y;

        return Math.sqrt(dx * dx + dy * dy);
    }

    static pathLength(path, graph) {
        if (!path || path.length < 2) return 0;

        let totalDistance = 0;

        for (let i = 0; i < path.length - 1; i++) {
            const currentNode = graph.getNode(path[i]);
            const nextNode = graph.getNode(path[i + 1]);

            if (currentNode && nextNode) {
                totalDistance += this.euclidean(currentNode, nextNode);
            }
        }

        return totalDistance;
    }

    static estimateTime(distance, speed = 1.0) {
        return distance / speed;
    }
}

module.exports = DistanceCalculator;
