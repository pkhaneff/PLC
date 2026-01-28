const { Worker } = require('worker_threads');
const EventEmitter = require('events');
const path = require('path');
const { logger } = require('../config/logger');

class WorkerManager extends EventEmitter {
  constructor() {
    super();
    this._plcWorkers = new Map();
    this._taskQueues = new Map();
    this._processingStatus = new Map();
    this._taskRegistry = new Map();
  }

  getOrCreateWorker(plcId) {
    if (this._plcWorkers.has(plcId)) {
      const worker = this._plcWorkers.get(plcId);

      if (worker && !worker.terminated) {
        logger.debug(`[WorkerManager] Reusing existing worker for ${plcId}`);
        return worker;
      } else {
        logger.debug(`[WorkerManager] Worker for ${plcId} is dead, creating new one`);
        this._plcWorkers.delete(plcId);
      }
    }

    logger.debug(`[WorkerManager] Creating new worker for ${plcId}`);
    const worker = this._createWorker(plcId);

    this._plcWorkers.set(plcId, worker);
    this._taskQueues.set(plcId, []);
    this._processingStatus.set(plcId, false);

    return worker;
  }

  _createWorker(plcId) {
    const worker = new Worker(path.join(__dirname, 'plc.worker.js'), {
      workerData: { plcId },
    });

    worker.on('message', (result) => {
      this._handleWorkerMessage(plcId, result);
    });

    worker.on('error', (error) => {
      logger.error(`[WorkerManager] Worker error for ${plcId}:`, error);
      this._handleWorkerError(plcId, error);
    });

    worker.on('exit', (code) => {
      logger.debug(`[WorkerManager] Worker for ${plcId} exited with code ${code}`);
      if (code !== 0) {
        this._handleWorkerCrash(plcId);
      }
    });

    worker.terminated = false;
    return worker;
  }

  _handleWorkerMessage(plcId, result) {
    const { taskId, status, data, error } = result;

    if (this._taskRegistry.has(taskId)) {
      const task = this._taskRegistry.get(taskId);
      task.status = status;
      task.completedAt = new Date();
      task.result = data;
      task.error = error;
    }

    if (status === 'success') {
      this.emit('task:completed', result);
    } else {
      this.emit('task:failed', result);
    }

    this._processingStatus.set(plcId, false);
    this._processNextTask(plcId);
  }

  _handleWorkerError(plcId, error) {
    logger.error(`[WorkerManager] Error from worker ${plcId}:`, error);
    this._processingStatus.set(plcId, false);
    this.emit('worker:error', { plcId, error });
  }

  _handleWorkerCrash(plcId) {
    logger.error(`[WorkerManager] Worker ${plcId} crashed!`);
    this._plcWorkers.delete(plcId);
    this._processingStatus.set(plcId, false);
    this.emit('worker:crashed', { plcId });
    this._retryQueuedTasks(plcId);
  }

  async executeTask(taskId, plcId, action = 'fetch_data', data = {}) {
    this._taskRegistry.set(taskId, {
      taskId,
      plcId,
      action,
      data,
      status: 'pending',
      createdAt: new Date(),
    });

    const worker = this.getOrCreateWorker(plcId);
    const isProcessing = this._processingStatus.get(plcId);

    if (isProcessing) {
      logger.debug(`[WorkerManager] Worker for ${plcId} is busy, queuing task ${taskId}`);
      return this._queueTask(plcId, { taskId, action, data });
    }

    return this._sendTaskToWorker(plcId, worker, { taskId, action, data });
  }

  _sendTaskToWorker(plcId, worker, task) {
    return new Promise((resolve, reject) => {
      const { taskId } = task;
      this._processingStatus.set(plcId, true);

      if (this._taskRegistry.has(taskId)) {
        this._taskRegistry.get(taskId).status = 'processing';
      }

      const completedHandler = (result) => {
        if (result.taskId === taskId) {
          this.removeListener('task:completed', completedHandler);
          this.removeListener('task:failed', failedHandler);
          resolve(result);
        }
      };

      const failedHandler = (result) => {
        if (result.taskId === taskId) {
          this.removeListener('task:completed', completedHandler);
          this.removeListener('task:failed', failedHandler);
          reject(new Error(result.error));
        }
      };

      this.on('task:completed', completedHandler);
      this.on('task:failed', failedHandler);

      logger.debug(`[WorkerManager] Sending task ${taskId} to worker for ${plcId}`);
      worker.postMessage(task);
    });
  }

  _queueTask(plcId, task) {
    const queue = this._taskQueues.get(plcId) || [];
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      this._taskQueues.set(plcId, queue);
    });
  }

  _processNextTask(plcId) {
    const queue = this._taskQueues.get(plcId);

    if (!queue || queue.length === 0) {
      logger.debug(`[WorkerManager] No more tasks in queue for ${plcId}`);
      return;
    }

    const { task, resolve, reject } = queue.shift();
    this._taskQueues.set(plcId, queue);

    logger.debug(`[WorkerManager] Processing next task from queue for ${plcId}`);

    const worker = this.getOrCreateWorker(plcId);
    this._sendTaskToWorker(plcId, worker, task).then(resolve).catch(reject);
  }

  _retryQueuedTasks(plcId) {
    const queue = this._taskQueues.get(plcId);

    if (!queue || queue.length === 0) {
      return;
    }

    logger.debug(`[WorkerManager] Retrying ${queue.length} queued tasks for ${plcId}`);
    this._processNextTask(plcId);
  }

  getTaskStatus(taskId) {
    if (!this._taskRegistry.has(taskId)) {
      return { status: 'not_found' };
    }
    return this._taskRegistry.get(taskId);
  }

  getWorkersInfo() {
    const workers = [];

    for (const [plcId, worker] of this._plcWorkers.entries()) {
      const queue = this._taskQueues.get(plcId) || [];
      const isProcessing = this._processingStatus.get(plcId);

      workers.push({
        plcId,
        isAlive: worker && !worker.terminated,
        isProcessing,
        queuedTasks: queue.length,
      });
    }

    return workers;
  }

  async terminateWorker(plcId) {
    const worker = this._plcWorkers.get(plcId);

    if (worker && !worker.terminated) {
      logger.debug(`[WorkerManager] Terminating worker for ${plcId}`);
      worker.terminated = true;
      await worker.terminate();
      this._plcWorkers.delete(plcId);
      this._taskQueues.delete(plcId);
      this._processingStatus.delete(plcId);
    }
  }

  async terminateAll() {
    logger.debug('[WorkerManager] Terminating all workers...');
    const terminatePromises = [];
    for (const plcId of this._plcWorkers.keys()) {
      terminatePromises.push(this.terminateWorker(plcId));
    }
    await Promise.all(terminatePromises);
    logger.debug('[WorkerManager] All workers terminated');
  }
}

module.exports = new WorkerManager();
