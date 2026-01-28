const NodeS7 = require('nodes7');
const EventEmitter = require('events');
const { logger } = require('../../config/logger');

class InitPlc extends EventEmitter {
  constructor(config, variables, options = {}) {
    super();

    this._config = config;
    this._variables = variables;
    this._plcId = config.id || 'PLC';

    this._connectionTimeout = options.connectionTimeout || 3000;
    this._reconnectInterval = options.reconnectInterval || 2000;
    this._fastRetryDelay = options.fastRetryDelay || 500;
    this._fastRetryLimit = options.fastRetryLimit || 5;

    this._conn = null;
    this.isConnected = false;
    this._isReading = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._values = {};
    this._pollingInterval = options.pollingInterval || 1000;
    this._pollingTimer = null;
    this._isShuttingDown = false;
  }

  async connectPlc() {
    if (this.isConnected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this._conn = new NodeS7();
      this._conn.globalTimeout = this._connectionTimeout;
      this._conn.silentMode = true;

      logger.debug(`[${this._plcId}] Connecting...`);

      this._conn.initiateConnection(this._config, (err) => {
        if (err) {
          logger.error(`[${this._plcId}] Connection failed:`, err.message);
          this.isConnected = false;
          this.scheduleReconnect();
          reject(err);
          return;
        }

        this._conn.setTranslationCB((tag) => this._variables[tag] || null);
        this._conn.addItems(Object.keys(this._variables));

        this.isConnected = true;
        this._reconnectAttempts = 0;
        this.emit('connected');
        resolve();
      });
    });
  }

  async disconnect() {
    if (!this._conn) {
      return;
    }

    this.stopPolling();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    return new Promise((resolve) => {
      this._conn.dropConnection(() => {
        this.isConnected = false;
        this.emit('disconnected');
        resolve();
      });
    });
  }

  async readItems() {
    if (!this.isConnected || !this._conn) {
      return { error: 'Not connected', values: {} };
    }

    return new Promise((resolve) => {
      this._conn.readAllItems((err, values) => {
        if (err) {
          const errorMsg = this.parseError(err);
          logger.error(`[${this._plcId}] Read error:`, errorMsg);

          this.handleReadError(errorMsg);
          resolve({ error: err, values: {} });
          return;
        }

        this._values = values;
        this.emit('data', values);
        resolve({ error: null, values });
      });
    });
  }

  async writeItems(tagName, value) {
    if (!this.isConnected || !this._conn) {
      return { error: 'Not connected' };
    }

    const tags = Array.isArray(tagName) ? tagName : [tagName];
    const values = Array.isArray(value) ? value : [value];

    return new Promise((resolve) => {
      logger.debug(`[${this._plcId}] Preparing to write: ${tags} = ${values}`);
      this._conn.writeItems(tags, values, (err) => {
        if (err) {
          const errorMsg = this.parseError(err);
          logger.error(`[${this._plcId}] Write error on ${tags}:`, errorMsg);
          resolve({ error: err });
          return;
        }
        logger.debug(`[${this._plcId}] Write success confirms locally: ${tags} = ${values}`);
        resolve({ error: null });
      });
    });
  }

  parseError(err) {
    if (typeof err === 'object' && err.message) {
      return err.message;
    }
    if (typeof err === 'string') {
      return err;
    }
    if (err === true) {
      return 'Invalid Response Code from PLC';
    }
    if (typeof err === 'number') {
      return `PLC Error Code: ${err}`;
    }
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }

  handleReadError(msg) {
    this.isConnected = false;
    this.emit('error', msg);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this._reconnectTimer || this._isShuttingDown) {
      return;
    }

    const delay = this._reconnectAttempts < this._fastRetryLimit ? this._fastRetryDelay : this._reconnectInterval;

    logger.debug(`[${this._plcId}] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts + 1})`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      this._reconnectAttempts++;

      try {
        await this.connectPlc();
      } catch (err) {
        logger.error(`[${this._plcId}] Reconnect failed`);
      }
    }, delay);
  }

  startPolling() {
    if (this._pollingTimer) {
      return;
    }

    const poll = async () => {
      if (this._isShuttingDown) {
        return;
      }

      if (this._isReading) {
        this._pollingTimer = setTimeout(poll, this._pollingInterval);
        return;
      }

      this._isReading = true;

      try {
        await this.readItems();
      } catch (err) {
        logger.error(`[${this._plcId}] Polling error:`, err.message);
      } finally {
        this._isReading = false;
      }

      this._pollingTimer = setTimeout(poll, this._pollingInterval);
    };

    poll();
  }

  stopPolling() {
    if (this._pollingTimer) {
      clearTimeout(this._pollingTimer);
      this._pollingTimer = null;
      logger.debug(`[${this._plcId}] Polling stopped`);
    }
  }

  async start() {
    try {
      await this.connectPlc();
      this.startPolling();
    } catch (err) {
      logger.error(`[${this._plcId}] Start failed:`, err.message);
      throw err;
    }
  }

  async shutdown() {
    this._isShuttingDown = true;
    this.stopPolling();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    await this.disconnect();
  }

  getValue(varName) {
    return this._values[varName];
  }

  getAllValues() {
    return this._values;
  }

  getStatus() {
    return {
      plcId: this._plcId,
      isConnected: this.isConnected,
      reconnectAttempts: this._reconnectAttempts,
      totalTags: Object.keys(this._variables).length,
      validTags: Object.keys(this._values).filter((k) => this._values[k] !== undefined).length,
    };
  }
}

module.exports = InitPlc;
