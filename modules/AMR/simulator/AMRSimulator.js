const http = require('http');
const { API_ENDPOINTS } = require('../config/api.endpoints');
const AMRState = require('./AMRState');

class AMRSimulator {
    constructor(amrId, port, startPosition) {
        this.amrId = amrId;
        this.port = port;
        this.state = new AMRState(amrId, startPosition);
        this.server = null;
        this.movementDuration = 3000;
    }

    start() {
        this.server = http.createServer((req, res) => {
            this._handleRequest(req, res);
        });

        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`[AMRSimulator] ${this.amrId} listening on port ${this.port}`);
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            console.log(`[AMRSimulator] ${this.amrId} stopped`);
        }
    }

    _handleRequest(req, res) {
        let body = '';

        req.on('data', (chunk) => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const request = JSON.parse(body);
                const response = this._processRequest(request);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: error.message }));
            }
        });
    }

    _processRequest(request) {
        const { request_code, data } = request;

        if (request_code === API_ENDPOINTS.STATUS.LOCATION) {
            return this._handleGetLocation();
        }

        if (request_code === API_ENDPOINTS.CONTROL.STOP) {
            return this._handleStop();
        }

        if (request_code === API_ENDPOINTS.CONTROL.RELOCATE) {
            return this._handleRelocate(data);
        }

        if (request_code === API_ENDPOINTS.CONTROL.MOTION) {
            return this._handleMotion(data);
        }

        if (request_code === API_ENDPOINTS.NAVIGATION.GO_TO_TARGET) {
            return this._handleGoToTarget(data);
        }

        if (request_code === API_ENDPOINTS.NAVIGATION.GO_TO_TARGET_LIST) {
            return this._handleGoToTargetList(data);
        }

        if (request_code === API_ENDPOINTS.NAVIGATION.PAUSE) {
            return this._handlePause();
        }

        if (request_code === API_ENDPOINTS.NAVIGATION.RESUME) {
            return this._handleResume();
        }

        if (request_code === API_ENDPOINTS.NAVIGATION.CANCEL) {
            return this._handleCancel();
        }

        return { status: 'error', message: `Unknown request code: ${request_code}` };
    }

    _handleGetLocation() {
        return {
            status: 'success',
            data: this.state.position,
        };
    }

    _handleStop() {
        this.state.stop();
        console.log(`[AMRSimulator] ${this.amrId} stopped`);
        return { status: 'success', data: { message: 'Stopped' } };
    }

    _handleRelocate(data) {
        this.state.position = { ...data };
        console.log(`[AMRSimulator] ${this.amrId} relocated to`, data);
        return { status: 'success', data: { message: 'Relocated' } };
    }

    _handleMotion(data) {
        console.log(`[AMRSimulator] ${this.amrId} motion command:`, data);
        return { status: 'success', data: { message: 'Motion executed' } };
    }

    _handleGoToTarget(data) {
        this.state.setTarget(data);

        console.log(`[AMRSimulator] ${this.amrId} moving to`, data);

        setTimeout(() => {
            this.state.completeMovement();
            console.log(`[AMRSimulator] ${this.amrId} arrived at`, this.state.position);
        }, this.movementDuration);

        return { status: 'success', data: { message: 'Moving to target' } };
    }


    _handleGoToTargetList(data) {
        const { targets, move_task_list } = data;

        if (move_task_list && move_task_list.length > 0) {
            return this._handleMoveTaskList(move_task_list);
        }

        if (targets && targets.length > 0) {
            console.log(`[AMRSimulator] ${this.amrId} moving to target list:`, targets);
            this.state.setTarget(targets[0]);

            setTimeout(() => {
                this.state.completeMovement();
                console.log(`[AMRSimulator] ${this.amrId} completed target list`);
            }, this.movementDuration * targets.length);
        }

        return { status: 'success', data: { message: 'Moving to target list' } };
    }

    _handleMoveTaskList(taskList) {
        console.log(`\n[AMRSimulator] ${this.amrId} ========== EXECUTING TASK LIST ==========`);
        console.log(`[AMRSimulator] ${this.amrId} Total tasks: ${taskList.length}`);

        taskList.forEach((task, index) => {
            console.log(
                `[AMRSimulator] ${this.amrId}   ${index + 1}. ${task.source_id} → ${task.id}` +
                `${task.operation ? ` [${task.operation}]` : ''}`
            );
        });

        this._executeTaskSequence(taskList, 0);

        return {
            status: 'success',
            data: {
                message: 'Executing task list',
                total_tasks: taskList.length,
            },
        };
    }

    _executeTaskSequence(taskList, index) {
        if (index >= taskList.length) {
            console.log(`\n[AMRSimulator] ${this.amrId} ✅ ALL TASKS COMPLETED!\n`);
            return;
        }

        const task = taskList[index];
        const progress = `[${index + 1}/${taskList.length}]`;

        console.log(
            `\n[AMRSimulator] ${this.amrId} ${progress} 🚀 Moving: ${task.source_id} → ${task.id}` +
            `${task.operation ? ` | Operation: ${task.operation}` : ''}`
        );

        setTimeout(() => {
            console.log(
                `[AMRSimulator] ${this.amrId} ${progress} ✓ Arrived at ${task.id}` +
                `${task.operation ? ` | Executing ${task.operation}...` : ''}`
            );

            this._executeTaskSequence(taskList, index + 1);
        }, this.movementDuration);
    }


    _handlePause() {
        this.state.pause();
        console.log(`[AMRSimulator] ${this.amrId} paused`);
        return { status: 'success', data: { message: 'Paused' } };
    }

    _handleResume() {
        this.state.resume();
        console.log(`[AMRSimulator] ${this.amrId} resumed`);
        return { status: 'success', data: { message: 'Resumed' } };
    }

    _handleCancel() {
        this.state.cancel();
        console.log(`[AMRSimulator] ${this.amrId} task canceled`);
        return { status: 'success', data: { message: 'Task canceled' } };
    }
}

module.exports = AMRSimulator;
