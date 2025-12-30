const { logger } = require('../../logger/logger');
const shuttleService = require('./shuttleService');

class ShuttleManager {
    constructor() {
        logger.info('[ShuttleManager] Initialized with database backend');
    }

    async registerShuttle(shuttleId, startName, endName, path) {
        const shuttleData = await shuttleService.createShuttle(shuttleId, startName, endName, path);

        await shuttleService.reserveNode(shuttleId, startName);
        if (path.length > 1) {
            await shuttleService.reserveNode(shuttleId, path[1]);
        }

        logger.info(`[ShuttleManager] Shuttle ${shuttleId} registered: ${startName} -> ${endName}`);

        return shuttleData;
    }

    async blockNode(nodeName, shuttleId) {
        await shuttleService.reserveNode(shuttleId, nodeName);
        logger.debug(`[ShuttleManager] Node ${nodeName} reserved by ${shuttleId}`);
    }

    async unblockNode(nodeName, shuttleId) {
        await shuttleService.unreserveNode(shuttleId, nodeName);
        logger.debug(`[ShuttleManager] Node ${nodeName} unreserved by ${shuttleId}`);
        return true;
    }

    async isNodeBlocked(nodeName) {
        return await shuttleService.isNodeBlocked(nodeName);
    }

    async getNodeBlocker(nodeName) {
        return await shuttleService.getNodeBlocker(nodeName);
    }

    async getShuttle(shuttleId) {
        return await shuttleService.getShuttle(shuttleId);
    }

    async getAllShuttles() {
        return await shuttleService.getAllShuttles();
    }

    async getActiveShuttles() {
        return await shuttleService.getActiveShuttles();
    }

    async setShuttleWaiting(shuttleId, conflictWith) {
        const shuttle = await shuttleService.getShuttle(shuttleId);
 
        if (!shuttle) {
            throw new Error(`Shuttle ${shuttleId} not found`);
        }

        const waitingSince = shuttle.waiting_since || Date.now();
        await shuttleService.setShuttleWaiting(shuttleId, waitingSince);

        if (conflictWith) {
            await shuttleService.addConflict(shuttleId, conflictWith);
        }

        logger.info(`[ShuttleManager] Shuttle ${shuttleId} is now waiting (conflict with ${conflictWith})`);

        return await shuttleService.getShuttle(shuttleId);
    }

    async clearShuttleWaiting(shuttleId) {
        const shuttle = await shuttleService.getShuttle(shuttleId);

        if (!shuttle) {
            throw new Error(`Shuttle ${shuttleId} not found`);
        }

        await shuttleService.clearShuttleWaiting(shuttleId);

        logger.info(`[ShuttleManager] Shuttle ${shuttleId} waiting cleared, now running`);

        return await shuttleService.getShuttle(shuttleId);
    }

    async setRerouteBackup(shuttleId, backupPath) {
        const shuttle = await shuttleService.getShuttle(shuttleId);

        if (!shuttle) {
            throw new Error(`Shuttle ${shuttleId} not found`);
        }

        await shuttleService.setRerouteBackup(shuttleId, backupPath);

        logger.info(`[ShuttleManager] Shuttle ${shuttleId} reroute backup saved`);

        return await shuttleService.getShuttle(shuttleId);
    }

    async clearRerouteBackup(shuttleId) {
        const shuttle = await shuttleService.getShuttle(shuttleId);

        if (!shuttle) {
            throw new Error(`Shuttle ${shuttleId} not found`);
        }

        await shuttleService.savePath(shuttleId, [], true);

        logger.debug(`[ShuttleManager] Shuttle ${shuttleId} reroute backup cleared`);

        return await shuttleService.getShuttle(shuttleId);
    }

    async applyReroute(shuttleId, newPath) {
        const shuttle = await shuttleService.getShuttle(shuttleId);

        if (!shuttle) {
            throw new Error(`Shuttle ${shuttleId} not found`);
        }

        await shuttleService.applyReroute(shuttleId, newPath);

        const reservedNodes = await shuttleService.getReservedNodes(shuttleId);
        for (const node of reservedNodes) {
            await shuttleService.unreserveNode(shuttleId, node);
        }

        await shuttleService.reserveNode(shuttleId, newPath[0]);
        if (newPath.length > 1) {
            await shuttleService.reserveNode(shuttleId, newPath[1]);
        }

        logger.info(`[ShuttleManager] Shuttle ${shuttleId} rerouted with new path (${newPath.length} steps)`);

        return await shuttleService.getShuttle(shuttleId);
    }

    async removeShuttle(shuttleId) {
        const result = await shuttleService.removeShuttle(shuttleId);

        if (result) {
            logger.info(`[ShuttleManager] Shuttle ${shuttleId} removed from registry`);
        }

        return result;
    }

    async clearAll() {
        await shuttleService.clearAll();
        logger.info('[ShuttleManager] All state cleared');
    }
}

module.exports = new ShuttleManager();
