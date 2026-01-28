const nodes7 = require('nodes7');
const EventEmitter = require('events');
const { logger } = require('../../config/logger');

class InitPlc extends EventEmitter {
  constructor(config, variables, options = {}) {
    super();

    this.config = config;
    this.variables = variables;
    this.plcId = config.id || 'PLC';

    this.connectionTimeout = options.connectionTimeout || 3000;
    this.reconnectInterval = options.reconnectInterval || 2000;
    this.fastRetryDelay = options.fastRetryDelay || 500;
    this.fastRetryLimit = options.fastRetryLimit || 5;

    this.conn = null;
    this.isConnected = false;
    this.isReading = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.values = {};
    this.pollingInterval = options.pollingInterval || 1000;
    this.pollingTimer = null;
    this.isShuttingDown = false;
  }

  async connectPlc() {
    if (this.isConnected) return;

    return new Promise((resolve, reject) => {
      this.conn = new nodes7();
      this.conn.globalTimeout = this.connectionTimeout;
      this.conn.silentMode = true;

      logger.debug(`[${this.plcId}] Connecting...`);

      this.conn.initiateConnection(this.config, (err) => {
        if (err) {
          logger.error(`[${this.plcId}] Connection failed:`, err.message);
          this.isConnected = false;
          this.scheduleReconnect();
          reject(err);
          return;
        }

        this.conn.setTranslationCB((tag) => this.variables[tag] || null);
        this.conn.addItems(Object.keys(this.variables));

        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connected');
        resolve();
      });
    });
  }

  async disConnect() {
    if (!this.conn) return;

    this.stopPolling();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return new Promise((resolve) => {
      this.conn.dropConnection(() => {
        this.isConnected = false;
        this.emit('disconnected');
        resolve();
      });
    });
  }

  async readItems() {
    if (!this.isConnected || !this.conn) {
      return { error: 'Not connected', values: {} };
    }

    return new Promise((resolve) => {
      this.conn.readAllItems((err, values) => {
        if (err) {
          const errorMsg = this.parseError(err);
          logger.error(`[${this.plcId}] Read error:`, errorMsg);

          this.handleReadError(errorMsg);
          resolve({ error: err, values: {} });
          return;
        }

        this.values = values;
        this.emit('data', values);
        resolve({ error: null, values });
      });
    });
  }

  async writeItems(tagName, value) {
    if (!this.isConnected || !this.conn) {
      return { error: 'Not connected' };
    }

    const tags = Array.isArray(tagName) ? tagName : [tagName];
    const values = Array.isArray(value) ? value : [value];

    return new Promise((resolve) => {
      logger.debug(`[${this.plcId}] Preparing to write: ${tags} = ${values}`);
      this.conn.writeItems(tags, values, (err) => {
        if (err) {
          const errorMsg = this.parseError(err);
          logger.error(`[${this.plcId}] Write error on ${tags}:`, errorMsg);
          resolve({ error: err });
          return;
        }
        logger.debug(`[${this.plcId}] Write success confirms locally: ${tags} = ${values}`);
        resolve({ error: null });
      });
    });
  }

  parseError(err) {
    if (typeof err === 'object' && err.message) return err.message;
    if (typeof err === 'string') return err;
    if (err === true) return 'Invalid Response Code from PLC';
    if (typeof err === 'number') return `PLC Error Code: ${err}`;
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
    if (this.reconnectTimer || this.isShuttingDown) return;

    const delay = this.reconnectAttempts < this.fastRetryLimit ? this.fastRetryDelay : this.reconnectInterval;

    logger.debug(`[${this.plcId}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;

      try {
        await this.connectPlc();
      } catch (err) {
        logger.error(`[${this.plcId}] Reconnect failed`);
      }
    }, delay);
  }

  startPolling() {
    if (this.pollingTimer) return;

    const poll = async () => {
      if (this.isShuttingDown) return;

      if (this.isReading) {
        this.pollingTimer = setTimeout(poll, this.pollingInterval);
        return;
      }

      this.isReading = true;

      try {
        await this.readItems();
      } catch (err) {
        logger.error(`[${this.plcId}] Polling error:`, err.message);
      } finally {
        this.isReading = false;
      }

      this.pollingTimer = setTimeout(poll, this.pollingInterval);
    };

    poll();
  }

  stopPolling() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
      logger.debug(`[${this.plcId}] Polling stopped`);
    }
  }

  async start() {
    try {
      await this.connectPlc();
      this.startPolling();
    } catch (err) {
      logger.error(`[${this.plcId}] Start failed:`, err.message);
      throw err;
    }
  }

  async shutdown() {
    this.isShuttingDown = true;
    this.stopPolling();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.disConnect();
  }

  getValue(varName) {
    return this.values[varName];
  }

  getAllValues() {
    return this.values;
  }

  getStatus() {
    return {
      plcId: this.plcId,
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      totalTags: Object.keys(this.variables).length,
      validTags: Object.keys(this.values).filter((k) => this.values[k] !== undefined).length,
    };
  }
}

module.exports = InitPlc;
