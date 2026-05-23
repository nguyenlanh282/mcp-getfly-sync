const orderSync = require('./src/jobs/orderSync');
const logger = require('./src/utils/logger');
logger.info = console.log;
logger.error = console.error;
logger.warn = console.warn;

orderSync.runSync(2).then(() => console.log('Done')).catch(console.error);
