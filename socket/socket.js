const { Server } = require('socket.io');
const { logger } = require('../logger/logger');
const socketConfig = {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
};

function setupSocketEvents(io) {
  const originalEmit = io.emit.bind(io);
  io.emit = function (event, ...args) {
    return originalEmit(event, ...args);
  };

  io.on('connection', (socket) => {
    socket.on('disconnect', (reason) => {});

    socket.on('error', (error) => {});
  });

  return io;
}

function initializeSocket(server) {
  const io = new Server(server, socketConfig);
  return setupSocketEvents(io);
}

module.exports = initializeSocket;
