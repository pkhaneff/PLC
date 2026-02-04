const Node = require('./Node');

class Graph {
    constructor() {
        this.nodes = new Map();
    }

    addNode(id, x, y) {
        if (!this.nodes.has(id)) {
            this.nodes.set(id, new Node(id, x, y));
        }
        return this.nodes.get(id);
    }

    getNode(id) {
        return this.nodes.get(id);
    }

    hasNode(id) {
        return this.nodes.has(id);
    }

    addEdge(fromId, toId) {
        const fromNode = this.nodes.get(fromId);
        const toNode = this.nodes.get(toId);

        if (!fromNode || !toNode) {
            return false;
        }

        const distance = fromNode.getDistance(toNode);
        fromNode.addNeighbor(toId, distance);
        return true;
    }

    getAllNodes() {
        return Array.from(this.nodes.values());
    }

    getNodeCount() {
        return this.nodes.size;
    }
}

module.exports = Graph;
