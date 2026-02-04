class AMRState {
    constructor(amrId, startPosition = { x: 0, y: 0, theta: 0, floor: 1 }) {
        this.amrId = amrId;
        this.position = { ...startPosition };
        this.targetPosition = null;
        this.status = 'IDLE';
        this.isMoving = false;
        this.taskId = null;
        this.moveTimeout = null;
    }

    setTarget(target) {
        this.targetPosition = { ...target };
        this.status = 'MOVING';
        this.isMoving = true;
    }

    completeMovement() {
        if (this.targetPosition) {
            this.position = { ...this.targetPosition };
        }
        this.targetPosition = null;
        this.status = 'IDLE';
        this.isMoving = false;
        this.taskId = null;
    }

    stop() {
        if (this.moveTimeout) {
            clearTimeout(this.moveTimeout);
            this.moveTimeout = null;
        }
        this.status = 'STOPPED';
        this.isMoving = false;
    }

    pause() {
        this.status = 'PAUSED';
    }

    resume() {
        if (this.targetPosition) {
            this.status = 'MOVING';
        }
    }

    cancel() {
        this.stop();
        this.targetPosition = null;
        this.taskId = null;
        this.status = 'IDLE';
    }

    getState() {
        return {
            amrId: this.amrId,
            position: this.position,
            targetPosition: this.targetPosition,
            status: this.status,
            isMoving: this.isMoving,
            taskId: this.taskId,
        };
    }
}

module.exports = AMRState;
