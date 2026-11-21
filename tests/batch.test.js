const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { readProducts } = require('../src/batch/product-reader');
const { BatchService, splitIntoBatches } = require('../src/batch/batch-service');
const cron = require('node-cron');

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-retail-batch-test-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function withServer(handler, run) {
  const server = createServer(handler);
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
    sku: `SKU-${String(index + 1).padStart(4, '0')}`,
    name: `Product ${index + 1}`,
    category: index % 2 === 0 ? 'Grocery' : 'Household',
    price: Number((index + 0.99).toFixed(2))
  }));
}

test('CSV reader accepts the product schema and batch splitting groups 200 into two lots of 100', async () => {
  await withTemporaryDirectory(async (directory) => {
    const products = makeProducts(200);
    const filePath = path.join(directory, 'products.csv');
    const rows = [
      'sku,name,category,price',
      ...products.map((product) =>
        `${product.sku},"${product.name}",${product.category},${product.price}`
      )
    ];
    await fs.writeFile(filePath, rows.join('\n'), 'utf8');

    const loaded = await readProducts(filePath);
    const batches = splitIntoBatches(loaded);
    assert.equal(loaded.length, 200);
    assert.deepEqual(batches.map((batch) => batch.length), [100, 100]);
  });
});

test('checked-in sample catalog has at least 200 valid products and the daily schedule is valid', async () => {
  const sampleFile = path.resolve(__dirname, '../data/products.json');
  const products = await readProducts(sampleFile);
  assert.ok(products.length >= 200);
  assert.equal(cron.validate('0 0 * * *'), true);
});

test('manual batch CLI delivers the checked-in sample in two requests', async () => {
  await withTemporaryDirectory(async (directory) => {
    const received = [];
    await withServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200).end();
    }, async (targetUrl) => {
      const projectRoot = path.resolve(__dirname, '..');
      const sampleFile = path.join(projectRoot, 'data', 'products.json');
      const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'batch', 'cli.js')], {
        cwd: projectRoot,
        env: {
          ...process.env,
          BATCH_INPUT_FILE: sampleFile,
          BATCH_TARGET_URL: targetUrl,
          BATCH_TIMEOUT_MS: '2000',
          STATE_DIR: path.join(directory, 'state')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
      const [exitCode] = await once(child, 'close');

      assert.equal(exitCode, 0, output);
      assert.deepEqual(received.map((request) => request.products.length), [100, 100]);
    });
  });
});

test('JSON reader loads records and batch delivery preserves a failed batch for retry', async () => {
  await withTemporaryDirectory(async (directory) => {
    const products = makeProducts(205);
    const inputFile = path.join(directory, 'products.json');
    const failedBatchesDir = path.join(directory, 'failed');
    await fs.writeFile(inputFile, JSON.stringify(products), 'utf8');
    assert.equal((await readProducts(inputFile)).length, 205);

    const requests = [];
    let failedOnce = false;
    await withServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      if (body.batchNumber === 2 && !failedOnce) {
        failedOnce = true;
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200).end();
    }, async (targetUrl) => {
      const service = new BatchService({
        inputFile,
        targetUrl,
        timeoutMs: 2000,
        failedBatchesDir
      });

      const initial = await service.run();
      assert.deepEqual(initial, {
        runId: initial.runId,
        batchCount: 3,
        successRecords: 105,
        failedRecords: 100,
        failedBatches: 1
      });
      assert.deepEqual(requests.map((request) => request.products.length), [100, 100, 5]);
      assert.equal((await fs.readdir(failedBatchesDir)).length, 1);

      const retry = await service.retryFailed();
      assert.deepEqual(retry, { batchCount: 1, successRecords: 100, failedRecords: 0 });
      assert.deepEqual(requests.map((request) => request.products.length), [100, 100, 5, 100]);
      assert.equal((await fs.readdir(failedBatchesDir)).length, 0);
    });
  });

});

test('manual batch sender persists a batch when the receiver is unavailable', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputFile = path.join(directory, 'products.json');
    const failedBatchesDir = path.join(directory, 'failed');
    await fs.writeFile(inputFile, JSON.stringify(makeProducts(2)), 'utf8');

    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    probe.close();
    await once(probe, 'close');

    const service = new BatchService({
      inputFile,
      targetUrl: `http://127.0.0.1:${port}/api/v1/products/batch`,
      timeoutMs: 1000,
      failedBatchesDir
    });

    const result = await service.run();
    assert.equal(result.batchCount, 1);
    assert.equal(result.successRecords, 0);
    assert.equal(result.failedRecords, 2);
    assert.equal(result.failedBatches, 1);
    const failureFiles = await fs.readdir(failedBatchesDir);
    assert.equal(failureFiles.length, 1);
    const failure = JSON.parse(await fs.readFile(path.join(failedBatchesDir, failureFiles[0]), 'utf8'));
    assert.equal(failure.products.length, 2);
  });
});
