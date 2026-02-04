
class ConflictDetectionService {
    detectPathConflict(path1, path2) {
        if (!path1 || !path2) return null;

        const intersections = [];

        for (let i = 0; i < path1.length; i++) {
            const index = path2.indexOf(path1[i]);
            if (index !== -1) {
                intersections.push({
                    nodeId: path1[i],
                    path1Index: i,
                    path2Index: index
                });
            }
        }

        if (intersections.length === 0) return null;

        return {
            type: this.classifyConflictType(path1, path2, intersections),
            intersections,
            severity: this.calculateSeverity(intersections)
        };
    }

    classifyConflictType(path1, path2, intersections) {
        if (intersections.length === 0) return 'NONE';

        const firstIntersection = intersections[0];
        const isHeadOn = this.isHeadOnCollision(path1, path2, firstIntersection);

        if (isHeadOn) return 'HEAD_ON';
        if (intersections.length > 1) return 'INTERSECTION';

        return 'FOLLOWING';
    }

    isHeadOnCollision(path1, path2, intersection) {
        const idx1 = intersection.path1Index;
        const idx2 = intersection.path2Index;

        if (idx1 > 0 && idx2 < path2.length - 1) {
            const prevNode1 = path1[idx1 - 1];
            const nextNode2 = path2[idx2 + 1];
            return prevNode1 === nextNode2;
        }

        return false;
    }

    calculateSeverity(intersections) {
        if (intersections.length === 0) return 0;
        if (intersections.length === 1) return 50;
        return Math.min(100, 50 + intersections.length * 10);
    }

    calculateConflictRisk(path, reservedNodes) {
        if (!path || !reservedNodes) return 0;

        const conflictCount = path.filter(node =>
            reservedNodes.includes(node)
        ).length;

        const riskScore = (conflictCount / path.length) * 100;

        return Math.min(100, riskScore);
    }

    suggestResolution(conflict) {
        if (!conflict) return 'PROCEED';

        switch (conflict.type) {
            case 'HEAD_ON':
                return 'WAIT_OR_REROUTE';
            case 'INTERSECTION':
                return 'PRIORITY_BASED';
            case 'FOLLOWING':
                return 'WAIT';
            default:
                return 'PROCEED';
        }
    }
}

module.exports = new ConflictDetectionService();
