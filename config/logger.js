const winston = require('winston');

const LEVEL_COLORS = {
  debug: '\x1b[38;5;32m',
  info: '\x1b[38;5;36m',
  warn: '\x1b[38;5;221m',
  error: '\x1b[38;5;196m',
  critical: '\x1b[48;5;196;38;5;231m',
};
const RESET_COLOR = '\x1b[0m';
const TIME_COLOR = '\x1b[38;5;244m';
const NAME_COLOR = '\x1b[38;5;214m';
const MESSAGE_COLOR = '\x1b[38;5;111m';

const uvicornFormatter = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, service = 'app' }) => {
    const levelColor = LEVEL_COLORS[level] || '';
    const coloredLevel = `${levelColor}${level.toUpperCase().padEnd(7)}${RESET_COLOR}`;
    const coloredTime = `${TIME_COLOR}${timestamp}${RESET_COLOR}`;
    const coloredService = `${NAME_COLOR}${service}${RESET_COLOR}`;
    const coloredMessage = `${MESSAGE_COLOR}${message}${RESET_COLOR}`;

    return `${coloredTime} | ${coloredLevel} | ${coloredService} : ${coloredMessage}`;
  })
);

function configureLogging() {
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.errors({ stack: true }), winston.format.json()),
    defaultMeta: { service: 'app' },
    transports: [
      new winston.transports.Console({
        level: 'info',
        format: uvicornFormatter,
      }),
    ],
  });
  return logger;
}

const customLogger = configureLogging();

process.on('unhandledRejection', (ex) => {
  customLogger.error('Unhandled Promise Rejection:', ex);
  process.exit(1);
});

process.on('uncaughtException', (ex) => {
  customLogger.error('Uncaught Exception:', ex);
  process.exit(1);
});

module.exports = {
  logger: customLogger,
  configureLogging,
};
