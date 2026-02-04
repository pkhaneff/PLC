const Graph = require('../models/Graph');
const nodesConfig = require('../nodes.config');

class MapLoaderService {
    constructor() {
        this.graph = null;
    }

    loadMap() {
        this.graph = this.buildGraph(nodesConfig);
        return this.graph;
    }

    buildGraph(config) {
        const graph = new Graph();

        Object.values(config.nodes).forEach(node => {
            graph.addNode(node.id, node.x, node.y);
        });

        Object.keys(config.connections).forEach(fromId => {
            const toIds = config.connections[fromId];
            toIds.forEach(toId => {
                if (graph.hasNode(fromId) && graph.hasNode(toId)) {
                    graph.addEdge(fromId, toId);
                }
            });
        });

        return graph;
    }

    getGraph() {
        if (!this.graph) {
            this.loadMap();
        }
        return this.graph;
    }
}

module.exports = new MapLoaderService();
