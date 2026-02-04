const axios = require('axios');

class HttpClient {
    async get(url, timeout = 5000) {
        try {
            const response = await axios.get(url, { timeout });
            return response.data;
        } catch (error) {
            throw new Error(`HTTP GET failed: ${error.message}`);
        }
    }

    async post(url, data, timeout = 5000) {
        try {
            const response = await axios.post(url, data, { timeout });
            return response.data;
        } catch (error) {
            throw new Error(`HTTP POST failed: ${error.message}`);
        }
    }
}

module.exports = HttpClient;
