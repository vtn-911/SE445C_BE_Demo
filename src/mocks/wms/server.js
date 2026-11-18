const config = require('../../config');
const logger = require('../../logger');
const { createWmsMockApp } = require('./app');

const server = createWmsMockApp({ inventory: config.wms.mockInventory })
  .listen(config.wms.mockPort, () => {
    logger.info('Mock WMS API started', { port: config.wms.mockPort });
  });

function shutdown(signal) {
  logger.info('Shutting down Mock WMS API', { signal });
  server.close((error) => {
    if (error) {
      logger.error('Mock WMS API shutdown failed', { error: error.message });
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
