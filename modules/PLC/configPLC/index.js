const plc1 = require('./plc1');
const plc2 = require('./plc2');
const { tag_plc_1, tag_plc_2 } = require('../tag');

const plcsConfig = [
    {
        plcConfig: plc1.config,
        variables: tag_plc_1,
        options: plc1.options
    },
    {
        plcConfig: plc2.config,
        variables: tag_plc_2,
        options: plc2.options
    }
];

module.exports = {
    plcsConfig
};
