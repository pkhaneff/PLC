const fs = require('fs');
const path = require('path');

class MapConfigGenerator {
    constructor() {
        this.mapPath = path.join(__dirname, '../mapAMR.smap');
        this.configPath = path.join(__dirname, '../nodes.config.js');
    }

    generateConfig() {
        const mapData = JSON.parse(fs.readFileSync(this.mapPath, 'utf-8'));

        const nodes = this.extractNodes(mapData.advancedPointList);
        const connections = this.extractConnections(mapData.advancedCurveList);

        this.writeConfigFile(nodes, connections);

        return { nodes, connections };
    }

    extractNodes(pointList) {
        const nodes = {};

        pointList.forEach(point => {
            if (point.instanceName && point.pos) {
                nodes[point.instanceName] = {
                    id: point.instanceName,
                    x: point.pos.x,
                    y: point.pos.y
                };
            }
        });

        return nodes;
    }

    extractConnections(curveList) {
        const connections = {};

        curveList.forEach(curve => {
            if (!curve.startPos || !curve.endPos) return;

            const fromId = curve.startPos.instanceName;
            const toId = curve.endPos.instanceName;

            if (!fromId || !toId) return;

            if (!connections[fromId]) {
                connections[fromId] = [];
            }

            if (!connections[fromId].includes(toId)) {
                connections[fromId].push(toId);
            }
        });

        Object.keys(connections).forEach(key => {
            connections[key].sort();
        });

        return connections;
    }

    writeConfigFile(nodes, connections) {
        const configContent = `// Auto-generated from mapAMR.smap
// Do not edit manually - use generateMapConfig() to regenerate

module.exports = {
  nodes: ${JSON.stringify(nodes, null, 4)},
  
  connections: ${JSON.stringify(connections, null, 4)}
};
`;

        fs.writeFileSync(this.configPath, configContent);
        console.log(`✓ Generated config: ${this.configPath}`);
    }
}

function generateMapConfig() {
    const generator = new MapConfigGenerator();
    const result = generator.generateConfig();

    console.log(`\n✓ Nodes: ${Object.keys(result.nodes).length}`);
    console.log(`✓ Connections: ${Object.keys(result.connections).length}\n`);

    return result;
}

module.exports = { MapConfigGenerator, generateMapConfig };
