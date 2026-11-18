const path = require('node:path');
const config = require('../../config');
const logger = require('../../logger');
const { ShipmentsRepository } = require('../../repositories/shipments-repository');
const { createTmsMockApp } = require('./app');

const shipmentsRepository = new ShipmentsRepository(path.resolve(config.stateDir, 'tms'));
const server = createTmsMockApp({ shipmentsRepository })
  .listen(config.tms.mockPort, () => {
    logger.info('Mock TMS API started', { port: config.tms.mockPort });
  });

function shutdown(signal) {
  logger.info('Shutting down Mock TMS API', { signal });
  server.close((error) => {
    if (error) {
      logger.error('Mock TMS API shutdown failed', { error: error.message });
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
