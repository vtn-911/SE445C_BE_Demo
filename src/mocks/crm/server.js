const path = require('node:path');
const config = require('../../config');
const logger = require('../../logger');
const { CustomersRepository } = require('../../repositories/customers-repository');
const { createMockCrmApp } = require('./app');

const customersRepository = new CustomersRepository(path.resolve(config.stateDir));
const server = createMockCrmApp({ customersRepository })
  .listen(config.crm.mockPort, () => {
    logger.info('Mock CRM API started', { port: config.crm.mockPort });
  });

function shutdown(signal) {
  logger.info('Mock CRM API shutting down', { signal });
  server.close((error) => {
    if (error) {
      logger.error('Mock CRM API shutdown failed', { error: error.message });
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
