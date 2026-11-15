const path = require('node:path');
const config = require('../config');
const { BatchService } = require('./batch-service');
const logger = require('../logger');

const service = new BatchService({
  inputFile: path.resolve(config.batch.inputFile),
  targetUrl: config.batch.targetUrl,
  timeoutMs: config.batch.timeoutMs,
  failedBatchesDir: path.resolve(config.stateDir, 'batch-failures')
});

async function main() {
  const command = process.argv[2] || 'run';
  const summary = command === 'retry'
    ? await service.retryFailed()
    : command === 'run'
      ? await service.run()
      : (() => { throw new Error(`Unknown batch command: ${command}`); })();

  if (summary.failedRecords > 0) process.exitCode = 1;
}

main().catch((error) => {
  logger.error('Batch command failed', { error: error.message });
  process.exitCode = 1;
});
