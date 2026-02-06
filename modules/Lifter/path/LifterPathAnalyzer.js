const { logger } = require('../../../config/logger');

class LifterPathAnalyzer {
    analyzePathForLifter(path, lifterNodes) {
        if (!path || !path.totalStep || path.totalStep === 0) {
            return null;
        }

        logger.debug(`[LifterPathAnalyzer] Checking ${path.totalStep} steps against lifter nodes: ${JSON.stringify(lifterNodes)}`);

        for (let i = 1; i <= path.totalStep; i++) {
            const stepString = path[`step${i}`];
            if (!stepString) continue;

            const qrCode = stepString.split('>')[0];
            logger.debug(`[LifterPathAnalyzer] Step ${i}: ${qrCode}`);

            if (lifterNodes.includes(qrCode)) {
                const waitNodeIndex = i - 1;
                const waitNodeQr = waitNodeIndex > 0 ? path[`step${waitNodeIndex}`]?.split('>')[0] : null;
                const isExiting = i === 1; // Lifter is first step = shuttle is exiting lifter area

                logger.info(`[LifterPathAnalyzer] Found lifter node ${qrCode} at step ${i}, wait at step ${waitNodeIndex} (${waitNodeQr}), isExiting=${isExiting}`);

                return {
                    lifterIndex: i,
                    lifterQr: qrCode,
                    waitNodeIndex,
                    waitNodeQr,
                    isExiting,
                };
            }
        }

        logger.debug(`[LifterPathAnalyzer] No lifter nodes found in path`);
        return null;
    }

    truncatePathToWaitNode(path, waitNodeIndex) {
        if (waitNodeIndex < 1) {
            return {
                totalStep: 0,
                steps: [],
            };
        }

        const truncated = { totalStep: waitNodeIndex };
        const steps = [];

        for (let i = 1; i <= waitNodeIndex; i++) {
            truncated[`step${i}`] = path[`step${i}`];
            const qr = path[`step${i}`].split('>')[0];
            steps.push(qr);
        }

        return {
            ...truncated,
            steps,
        };
    }
}

module.exports = new LifterPathAnalyzer();
