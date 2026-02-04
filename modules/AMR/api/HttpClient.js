const http = require('http');
const pollingConfig = require('../config/polling.config');

class HttpClient {
    constructor(timeout = pollingConfig.timeout.default) {
        this.timeout = timeout;
    }

    async sendRequest(ip, port, requestCode, payload = {}) {
        return new Promise((resolve, reject) => {
            const requestData = JSON.stringify({
                request_code: requestCode,
                data: payload,
            });

            const options = {
                hostname: ip,
                port: port,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestData),
                },
                timeout: this.timeout,
            };

            const req = http.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        resolve(parsed);
                    } catch (error) {
                        reject(new Error(`Invalid JSON response: ${error.message}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Request failed: ${error.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timeout after ${this.timeout}ms`));
            });

            req.write(requestData);
            req.end();
        });
    }

    async sendRequestWithRetry(ip, port, requestCode, payload = {}) {
        const { maxAttempts, backoffMs } = pollingConfig.retry;
        let lastError;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await this.sendRequest(ip, port, requestCode, payload);
            } catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    await this._sleep(backoffMs * attempt);
                }
            }
        }

        throw lastError;
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

module.exports = HttpClient;
