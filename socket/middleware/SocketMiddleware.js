function attachSocketService(req, res, next) {
    const socketService = require('../index');
    req.socketService = socketService;
    next();
}

module.exports = { attachSocketService };
