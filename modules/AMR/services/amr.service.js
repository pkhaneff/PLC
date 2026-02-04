const mapLoaderService = require('./mapLoader.service');
const PathfindingService = require('./pathfinding.service');
const taskGeneratorService = require('./taskGenerator.service');

class AMRService {
    constructor() {
        this.graph = null;
        this.pathfindingService = null;
    }

    initialize() {
        if (!this.graph) {
            this.graph = mapLoaderService.getGraph();
            this.pathfindingService = new PathfindingService(this.graph);
        }
    }

    generatePath(start, end, action) {
        this.initialize();

        if (!this.graph.hasNode(start)) {
            throw new Error(`Start node "${start}" not found in map`);
        }

        if (!this.graph.hasNode(end)) {
            throw new Error(`End node "${end}" not found in map`);
        }

        const path = this.pathfindingService.findPath(start, end);

        if (!path) {
            throw new Error(`No path found from "${start}" to "${end}"`);
        }

        return taskGeneratorService.generateMoveTaskList(path, action);
    }

    /**
     * Validate request and prepare path without executing
     * Used for async pattern - validate first, execute later
     * @returns {object} { valid: boolean, path: array, move_task_list: array, error: string }
     */
    validateAndPreparePath(start, end, action) {
        try {
            this.initialize();

            if (!this.graph.hasNode(start)) {
                return {
                    valid: false,
                    error: `Start node "${start}" not found in map`,
                };
            }

            if (!this.graph.hasNode(end)) {
                return {
                    valid: false,
                    error: `End node "${end}" not found in map`,
                };
            }

            const path = this.pathfindingService.findPath(start, end);

            if (!path) {
                return {
                    valid: false,
                    error: `No path found from "${start}" to "${end}"`,
                };
            }

            const result = taskGeneratorService.generateMoveTaskList(path, action);

            return {
                valid: true,
                path,
                move_task_list: result.move_task_list,
            };
        } catch (error) {
            return {
                valid: false,
                error: error.message,
            };
        }
    }


}

module.exports = new AMRService();
