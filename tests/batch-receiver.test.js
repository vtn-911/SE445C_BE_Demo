const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { BatchService } = require('../src/batch/batch-service');
const { createBatchReceiverApp } = require('../src/mocks/batch-receiver/app');
const { ProductBatchRepository } = require('../src/repositories/product-batch-repository');

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-retail-batch-receiver-test-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function withServer(app, run) {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function makeProducts(count) {
  return Array.from({ length: count }, (_, index) => ({
    sku: `BATCH-${String(index + 1).padStart(4, '0')}`,
    name: `Batch Product ${index + 1}`,
    category: 'Demo',
    price: index + 0.5
  }));
}

test('Batch Receiver accepts and persists a full 100-product sender batch', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = new ProductBatchRepository(directory);
    const app = createBatchReceiverApp({ productBatchRepository: repository });
    const batch = {
      runId: 'run-test-100',
      batchNumber: 1,
      products: makeProducts(100)
    };

    await withServer(app, async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);

      const accepted = await fetch(`${baseUrl}/api/v1/products/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch)
      });
      assert.equal(accepted.status, 202);
      assert.deepEqual(await accepted.json(), {
        success: true,
        data: { runId: batch.runId, batchNumber: 1, receivedRecords: 100, duplicate: false }
      });

      const query = await fetch(`${baseUrl}/api/v1/products/batches`);
      assert.equal(query.status, 200);
      const result = await query.json();
      assert.equal(result.data.batchCount, 1);
      assert.equal(result.data.productCount, 100);
      assert.deepEqual(result.data.batches[0].products, batch.products);
    });

    const persistedRepository = new ProductBatchRepository(directory);
    assert.equal((await persistedRepository.listBatches())[0].products.length, 100);
  });
});

test('existing Batch Sender delivers multiple 100-record batches to the Batch Receiver', async () => {
  await withTemporaryDirectory(async (directory) => {
    const products = makeProducts(205);
    const inputFile = path.join(directory, 'products.json');
    const failedBatchesDir = path.join(directory, 'failed');
    await fs.writeFile(inputFile, JSON.stringify(products), 'utf8');
    const repository = new ProductBatchRepository(path.join(directory, 'state'));
    const app = createBatchReceiverApp({ productBatchRepository: repository });

    await withServer(app, async (baseUrl) => {
      const service = new BatchService({
        inputFile,
        targetUrl: `${baseUrl}/api/v1/products/batch`,
        timeoutMs: 2000,
        failedBatchesDir
      });
      const result = await service.run();
      assert.equal(result.batchCount, 3);
      assert.equal(result.successRecords, 205);
      assert.equal(result.failedRecords, 0);

      const batches = await repository.listBatches();
      assert.deepEqual(batches.map((batch) => batch.products.length), [100, 100, 5]);
      assert.equal(batches.reduce((count, batch) => count + batch.products.length, 0), 205);
    });
  });
});

test('Batch Receiver rejects invalid envelopes and batches larger than 100 records', async () => {
  await withTemporaryDirectory(async (directory) => {
    const app = createBatchReceiverApp({
      productBatchRepository: new ProductBatchRepository(directory)
    });
    const invalidBatches = [
      { runId: '', batchNumber: 1, products: makeProducts(1) },
      { runId: 'run', batchNumber: 0, products: makeProducts(1) },
      { runId: 'run', batchNumber: 1, products: [] },
      { runId: 'run', batchNumber: 1, products: makeProducts(101) },
      {
        runId: 'run',
        batchNumber: 1,
        products: [{ sku: 'SKU1', name: 'Name', category: 'Demo', price: -1 }]
      }
    ];

    await withServer(app, async (baseUrl) => {
      for (const batch of invalidBatches) {
        const response = await fetch(`${baseUrl}/api/v1/products/batch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch)
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'INVALID_PRODUCT_BATCH');
      }
    });
  });
});

test('Batch Receiver treats identical retries as idempotent and rejects conflicting retries', async () => {
  await withTemporaryDirectory(async (directory) => {
    const app = createBatchReceiverApp({
      productBatchRepository: new ProductBatchRepository(directory)
    });
    const batch = { runId: 'run-idempotent', batchNumber: 1, products: makeProducts(2) };

    await withServer(app, async (baseUrl) => {
      const send = (payload) => fetch(`${baseUrl}/api/v1/products/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      assert.equal((await send(batch)).status, 202);
      const repeated = await send(batch);
      assert.equal(repeated.status, 200);
      assert.equal((await repeated.json()).data.duplicate, true);

      const conflict = await send({
        ...batch,
        products: [{ ...batch.products[0], price: 99 }]
      });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, 'BATCH_ID_CONFLICT');

      const query = await fetch(`${baseUrl}/api/v1/products/batches`);
      assert.equal((await query.json()).data.batchCount, 1);
    });
  });
});
