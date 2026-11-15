const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../logger');
const { readProducts } = require('./product-reader');
const { sendBatch } = require('./batch-sender');

const BATCH_SIZE = 100;

function splitIntoBatches(products, batchSize = BATCH_SIZE) {
  const batches = [];
  for (let offset = 0; offset < products.length; offset += batchSize) {
    batches.push(products.slice(offset, offset + batchSize));
  }
  return batches;
}

class BatchService {
  constructor({ inputFile, targetUrl, timeoutMs, failedBatchesDir, fetchImpl = fetch }) {
    this.inputFile = inputFile;
    this.targetUrl = targetUrl;
    this.timeoutMs = timeoutMs;
    this.failedBatchesDir = failedBatchesDir;
    this.fetchImpl = fetchImpl;
  }

  async run() {
    const products = await readProducts(this.inputFile);
    const batches = splitIntoBatches(products);
    const runId = crypto.randomUUID();
    const summary = {
      runId,
      batchCount: batches.length,
      successRecords: 0,
      failedRecords: 0,
      failedBatches: 0
    };

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchNumber = index + 1;
      try {
        await sendBatch({
          targetUrl: this.targetUrl,
          batchNumber,
          runId,
          products: batch,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl
        });
        summary.successRecords += batch.length;
        logger.info('Product batch sent', { runId, batchNumber, records: batch.length });
      } catch (error) {
        const failurePath = await this.persistFailure({
          runId,
          batchNumber,
          targetUrl: this.targetUrl,
          products: batch,
          error: error.message
        });
        summary.failedRecords += batch.length;
        summary.failedBatches += 1;
        logger.error('Product batch failed and was saved for retry', {
          runId,
          batchNumber,
          records: batch.length,
          failurePath,
          error: error.message
        });
      }
    }

    logger.info('Product batch run completed', summary);
    return summary;
  }

  async retryFailed() {
    let files;
    try {
      files = (await fs.readdir(this.failedBatchesDir))
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return { batchCount: 0, successRecords: 0, failedRecords: 0 };
      throw error;
    }

    const summary = { batchCount: files.length, successRecords: 0, failedRecords: 0 };
    for (const fileName of files) {
      const filePath = path.join(this.failedBatchesDir, fileName);
      const failure = JSON.parse(await fs.readFile(filePath, 'utf8'));
      try {
        await sendBatch({
          targetUrl: this.targetUrl,
          batchNumber: failure.batchNumber,
          runId: failure.runId,
          products: failure.products,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl
        });
        await fs.unlink(filePath);
        summary.successRecords += failure.products.length;
        logger.info('Previously failed batch sent successfully', {
          runId: failure.runId,
          batchNumber: failure.batchNumber,
          records: failure.products.length
        });
      } catch (error) {
        summary.failedRecords += failure.products.length;
        logger.error('Previously failed batch remains available for retry', {
          failurePath: filePath,
          error: error.message
        });
      }
    }
    logger.info('Failed batch retry completed', summary);
    return summary;
  }

  async persistFailure(failure) {
    await fs.mkdir(this.failedBatchesDir, { recursive: true });
    const filePath = path.join(
      this.failedBatchesDir,
      `${failure.runId}-batch-${String(failure.batchNumber).padStart(3, '0')}.json`
    );
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' });
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
    return filePath;
  }
}

module.exports = { BatchService, BATCH_SIZE, splitIntoBatches };
