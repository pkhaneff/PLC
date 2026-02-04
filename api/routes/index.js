const healthRouter = require('./v1/health.routes');
const plcRouter = require('./v1/plc.routes');
const shuttleRouter = require('./v1/shuttle.routes');
const lifterRouter = require('./v1/lifter.routes');
const amrRouter = require('./v1/amr.routes');

function route(app) {
  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/plc', plcRouter);
  app.use('/api/v1/shuttle', shuttleRouter);
  app.use('/api/v1/lifter', lifterRouter);
  app.use('/api/v1/amr', amrRouter);
}

module.exports = route;
