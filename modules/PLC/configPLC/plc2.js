require('dotenv').config();

const plc2Config = {
    host: process.env.IP_PLC_2,
    port: 102,
    rack: 0,
    slot: 1,
    debug: false,
    id: 'PLC_2',
    is_active: true,
};

const plc2Options = {
    numConnections: 1,
    tagsPerConnection: 8,
};

module.exports = {
    config: plc2Config,
    options: plc2Options
};
