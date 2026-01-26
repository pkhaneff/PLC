const plc1 = require('./plc1');
const { tag_plc_1 } = require('../tag');

const plcsConfig = [
  {
    plcConfig: plc1.config,
    variables: tag_plc_1,
    options: plc1.options,
  },
];

module.exports = {
  plcsConfig,
};
