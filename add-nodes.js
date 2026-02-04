const fs = require('fs');
const nodeConnections = require('./modules/AMR/nodeConnections.config.js');

const mapPath = 'modules/AMR/mapAMR.smap';
const backupPath = 'modules/AMR/mapAMR.smap.backup';

// Restore from backup
if (fs.existsSync(backupPath)) {
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    fs.writeFileSync(mapPath, JSON.stringify(backup, null, 2));
    console.log('✓ Restored from backup');
}

const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));

// Add new nodes
const newNodes = [
    { instanceName: 'LM5', pos: { x: 6.5, y: -0.593 } },
    { instanceName: 'LM6', pos: { x: 6.5, y: -2.007 } },
    { instanceName: 'AP6', pos: { x: 9.0, y: -0.593 } },
    { instanceName: 'AP7', pos: { x: 9.0, y: -2.007 } },
    { instanceName: 'LM7', pos: { x: 1.8, y: 1.5 } },
    { instanceName: 'LM8', pos: { x: 1.8, y: -3.5 } },
    { instanceName: 'AP8', pos: { x: 5.0, y: 1.5 } },
    { instanceName: 'AP9', pos: { x: 5.0, y: -3.5 } },
    { instanceName: 'LM9', pos: { x: 7.5, y: 1.0 } },
    { instanceName: 'LM10', pos: { x: 7.5, y: -3.0 } }
];

newNodes.forEach(node => {
    data.advancedPointList.push(node);
});

// Build connections from config
data.advancedCurveList = [];
const processedPairs = new Set();

Object.keys(nodeConnections).forEach(fromNode => {
    const toNodes = nodeConnections[fromNode];

    toNodes.forEach(toNode => {
        const pairKey = [fromNode, toNode].sort().join('-');
        if (processedPairs.has(pairKey)) return;
        processedPairs.add(pairKey);

        const fromNodeData = data.advancedPointList.find(n => n.instanceName === fromNode);
        const toNodeData = data.advancedPointList.find(n => n.instanceName === toNode);

        if (!fromNodeData || !toNodeData) {
            console.warn(`⚠ Node not found: ${fromNode} or ${toNode}`);
            return;
        }

        const midX = (fromNodeData.pos.x + toNodeData.pos.x) / 2;
        const midY = (fromNodeData.pos.y + toNodeData.pos.y) / 2;

        // Add bidirectional connections
        [
            { from: fromNode, to: toNode, fromData: fromNodeData, toData: toNodeData },
            { from: toNode, to: fromNode, fromData: toNodeData, toData: fromNodeData }
        ].forEach(conn => {
            data.advancedCurveList.push({
                className: 'DegenerateBezier',
                instanceName: `${conn.from}-${conn.to}`,
                startPos: {
                    instanceName: conn.from,
                    pos: { x: conn.fromData.pos.x, y: conn.fromData.pos.y }
                },
                endPos: {
                    instanceName: conn.to,
                    pos: { x: conn.toData.pos.x, y: conn.toData.pos.y }
                },
                controlPos1: { x: midX, y: midY },
                controlPos2: { x: midX, y: midY },
                property: [
                    { key: 'direction', type: 'int', value: 'MA==', int32Value: 0 },
                    { key: 'movestyle', type: 'int', value: 'MA==', int32Value: 0 }
                ]
            });
        });
    });
});

fs.writeFileSync(mapPath, JSON.stringify(data, null, 2));

console.log('\n=== Map Generation Complete ===\n');
console.log(`✓ Total nodes: ${data.advancedPointList.length}`);
console.log(`✓ Total connections: ${processedPairs.size}\n`);

console.log('Node connections (from config):');
Object.keys(nodeConnections).forEach(node => {
    console.log(`${node} = {${nodeConnections[node].join(', ')}}`);
});
