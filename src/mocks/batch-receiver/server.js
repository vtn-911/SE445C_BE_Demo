const path = require('node:path');
const config = require('../../config');
const logger = require('../../logger');
const { ProductBatchRepository } = require('../../repositories/product-batch-repository');
const { createBatchReceiverApp } = require('./app');

const productBatchRepository = new ProductBatchRepository(path.resolve(config.stateDir));
const server = createBatchReceiverApp({ productBatchRepository })
  .listen(config.batchReceiver.mockPort, () => {
    logger.info('Product batch receiver started', { port: config.batchReceiver.mockPort });
  });

function shutdown(signal) {
  logger.info('Product batch receiver shutting down', { signal });
  server.close((error) => {
    if (error) {
      logger.error('Product batch receiver shutdown failed', { error: error.message });
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
