const express = require('express');
const { HttpError, asyncHandler, errorHandler } = require('../../errors');
const logger = require('../../logger');

const MAX_BATCH_SIZE = 100;
const PRODUCT_FIELDS = ['sku', 'name', 'category', 'price'];
const PRODUCT_FIELD_SET = new Set(PRODUCT_FIELDS);

function normalizeProduct(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return null;
  const keys = Object.keys(product).sort();
  if (keys.length !== PRODUCT_FIELDS.length ||
      keys.some((key) => !PRODUCT_FIELD_SET.has(key))) {
    return null;
  }
  const sku = typeof product.sku === 'string' ? product.sku.trim() : '';
  const name = typeof product.name === 'string' ? product.name.trim() : '';
  const category = typeof product.category === 'string' ? product.category.trim() : '';
  if (
    !/^[A-Za-z0-9._-]{1,100}$/.test(sku) ||
    !name ||
    !category ||
    typeof product.price !== 'number' ||
    !Number.isFinite(product.price) ||
    product.price < 0
  ) {
    return null;
  }
  return { sku, name, category, price: product.price };
}

function normalizeBatch(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof body.runId !== 'string' ||
    !body.runId.trim() ||
    body.runId.trim().length > 100 ||
    !Number.isSafeInteger(body.batchNumber) ||
    body.batchNumber <= 0 ||
    !Array.isArray(body.products) ||
    body.products.length < 1 ||
    body.products.length > MAX_BATCH_SIZE
  ) {
    return null;
  }

  const products = body.products.map(normalizeProduct);
  if (products.some((product) => product === null)) return null;
  return {
    runId: body.runId.trim(),
    batchNumber: body.batchNumber,
    products
  };
}

function createBatchReceiverApp({ productBatchRepository }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.log = logger;
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));
  app.post('/api/v1/products/batch', asyncHandler(async (req, res) => {
    const batch = normalizeBatch(req.body);
    if (!batch) {
      throw new HttpError(
        400,
        'INVALID_PRODUCT_BATCH',
        'runId, positive batchNumber, and 1 to 100 valid products are required'
      );
    }

    const result = await productBatchRepository.acceptBatch(batch);
    if (result.status === 'conflict') {
      throw new HttpError(409, 'BATCH_ID_CONFLICT', 'Batch identifier was already used for different products');
    }

    const duplicate = result.status === 'duplicate';
    logger.info('Product batch received', {
      runId: batch.runId,
      batchNumber: batch.batchNumber,
      records: batch.products.length,
      duplicate
    });
    res.status(duplicate ? 200 : 202).json({
      success: true,
      data: {
        runId: batch.runId,
        batchNumber: batch.batchNumber,
        receivedRecords: batch.products.length,
        duplicate
      }
    });
  }));
  app.get('/api/v1/products/batches', asyncHandler(async (req, res) => {
    const batches = await productBatchRepository.listBatches();
    const productCount = batches.reduce((total, batch) => total + batch.products.length, 0);
    res.json({
      success: true,
      data: { batches, batchCount: batches.length, productCount }
    });
  }));
  app.use(errorHandler);
  return app;
}

module.exports = { createBatchReceiverApp };
