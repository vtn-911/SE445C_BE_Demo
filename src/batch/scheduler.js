const path = require('node:path');
const cron = require('node-cron');
const config = require('../config');
const logger = require('../logger');
const { BatchService } = require('./batch-service');

const service = new BatchService({
  inputFile: path.resolve(config.batch.inputFile),
  targetUrl: config.batch.targetUrl,
  timeoutMs: config.batch.timeoutMs,
  failedBatchesDir: path.resolve(config.stateDir, 'batch-failures')
});

let running = false;
const task = cron.schedule('0 0 * * *', async () => {
  if (running) {
    logger.warn('Daily product batch skipped because the previous run is still active');
    return;
  }
  running = true;
  try {
    await service.run();
  } catch (error) {
    logger.error('Daily product batch failed before delivery', { error: error.message });
  } finally {
    running = false;
  }
}, { timezone: config.batch.cronTimezone });

task.start();
logger.info('Daily product batch scheduler started', {
  schedule: '0 0 * * *',
  timezone: config.batch.cronTimezone
});

function shutdown(signal) {
  logger.info('Stopping product batch scheduler', { signal });
  task.stop();
  process.exitCode = 0;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
