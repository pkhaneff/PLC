const StateRepository = require('../state/StateRepository');
const ReservationRepository = require('../reservation/ReservationRepository');
const AMRLogger = require('../utils/AMRLogger');

class DeadlockDetector {
    async detectDeadlock(amrStates = null) {
        try {
            const states = amrStates || await StateRepository.getAllStates();
            const waitingAMRs = states.filter(s => s.status === 'MOVING');

            if (waitingAMRs.length < 2) return null;

            const graph = await this.buildWaitGraph(waitingAMRs);
            const cycle = this.findCycle(graph);

            if (cycle) {
                AMRLogger.conflict('Deadlock detected', { cycle });
                return {
                    detected: true,
                    cycle,
                    amrCount: cycle.length
                };
            }

            return null;
        } catch (error) {
            AMRLogger.error('Deadlock', 'Detection failed', error);
            return null;
        }
    }

    async buildWaitGraph(amrStates) {
        const graph = new Map();

        for (const amr of amrStates) {
            const reservedPath = amr.reservedPath || [];
            const waitingFor = [];

            for (const nodeId of reservedPath) {
                const reservation = await ReservationRepository.getReservation(nodeId);

                if (reservation && reservation.amrId !== amr.amrId) {
                    if (!waitingFor.includes(reservation.amrId)) {
                        waitingFor.push(reservation.amrId);
                    }
                }
            }

            graph.set(amr.amrId, waitingFor);
        }

        return graph;
    }

    findCycle(graph) {
        const visited = new Set();
        const recursionStack = new Set();

        for (const [node] of graph) {
            if (this.detectCycleUtil(node, graph, visited, recursionStack, [])) {
                return Array.from(recursionStack);
            }
        }

        return null;
    }

    detectCycleUtil(node, graph, visited, recursionStack, path) {
        visited.add(node);
        recursionStack.add(node);
        path.push(node);

        const neighbors = graph.get(node) || [];

        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                if (this.detectCycleUtil(neighbor, graph, visited, recursionStack, path)) {
                    return true;
                }
            } else if (recursionStack.has(neighbor)) {
                return true;
            }
        }

        recursionStack.delete(node);
        path.pop();
        return false;
    }

    breakDeadlock(deadlockCycle) {
        if (!deadlockCycle || deadlockCycle.length === 0) {
            return null;
        }

        return {
            action: 'FORCE_RELEASE',
            targetAMR: deadlockCycle[0],
            reason: 'Breaking deadlock cycle'
        };
    }
}

module.exports = new DeadlockDetector();
