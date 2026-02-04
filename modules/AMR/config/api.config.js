module.exports = {
    endpoints: {
        location: {
            port: 8001,
            path: '/api/location',
            timeout: 5000
        },
        battery: {
            port: 8002,
            path: '/api/battery',
            timeout: 5000
        },
        cargo: {
            port: 8003,
            path: '/api/cargo',
            timeout: 5000
        },
        status: {
            port: 8004,
            path: '/api/status',
            timeout: 5000
        },
        sensors: {
            port: 8005,
            path: '/api/sensors',
            timeout: 5000
        }
    }
};
