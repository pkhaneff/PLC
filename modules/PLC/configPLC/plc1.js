require('dotenv').config();

const plc1Config = {
  host: process.env.IP_PLC_1,
  port: 102,
  rack: 0,
  slot: 1,
  debug: false,
  id: 'PLC_1',
  is_active: true,
};

const plc1Options = {
  numConnections: 1,
  tagsPerConnection: 8,
};

module.exports = {
  config: plc1Config,
  options: plc1Options,
};
