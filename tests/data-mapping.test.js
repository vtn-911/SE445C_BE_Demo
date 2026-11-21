const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { DataMappingAdapter } = require('../src/integrations/data-mapping/mapping-adapter');

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

const canonicalResponse = {
  status: 'success',
  canonicalVersion: 'Product-v1',
  data: {
    sku: 'SKU-0001',
    name: 'Organic Apples 1',
    category: 'Fresh Produce',
    price: 4.99
  },
  mapping: {
    sku: '/ProductCode',
    name: '/ProductName',
    category: '/ProductCategory',
    price: '/UnitPrice'
  },
  confidence: 'high',
  warnings: []
};

test('data mapping route returns canonical product without creating an order', async () => {
  let received;
  const app = createApp({
    inventoryService: { lookup: async () => ({ sku: 'SKU123', availableQuantity: 50 }) },
    dataMappingService: {
      mapProduct: async (input) => {
        received = input;
        return { statusCode: 200, body: canonicalResponse };
      }
    }
  });

  await withServer(app, async (baseUrl) => {
    const requestBody = {
      format: 'json',
      payload: {
        ProductCode: 'SKU-0001',
        ProductName: 'Organic Apples 1',
        ProductCategory: 'Fresh Produce',
        UnitPrice: 4.99
      }
    };
    const response = await fetch(`${baseUrl}/api/v1/data-mapping/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), canonicalResponse);
    assert.deepEqual(received, requestBody);
  });
});

test('data mapping route preserves needsReview response', async () => {
  const review = {
    status: 'needsReview',
    canonicalVersion: 'Product-v1',
    mapping: { sku: '/ProductCode' },
    confidence: 'low',
    unmappedFields: ['name', 'category', 'price'],
    warnings: ['Source fields are ambiguous']
  };
  const app = createApp({
    inventoryService: { lookup: async () => ({ sku: 'SKU123', availableQuantity: 50 }) },
    dataMappingService: {
      mapProduct: async () => ({ statusCode: 422, body: review })
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/data-mapping/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'json', payload: { ProductCode: 'SKU-0001' } })
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), review);
  });
});

test('malformed JSON receives HTTP 400 without echoing source text', async () => {
  const app = createApp({
    inventoryService: { lookup: async () => ({ sku: 'SKU123', availableQuantity: 50 }) },
    dataMappingService: { mapProduct: async () => assert.fail('invalid JSON must not call mapping') }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/data-mapping/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"format":"json","payload":'
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_JSON');
  });
});

test('adapter forwards JSON/XML envelopes to the internal Python service', async () => {
  const requests = [];
  const adapter = new DataMappingAdapter({
    serviceUrl: 'http://127.0.0.1:3400/',
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(canonicalResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const envelopes = [
    { format: 'json', payload: { ProductCode: 'SKU-0001' } },
    { format: 'xml', payload: '<Product><ProductCode>SKU-0001</ProductCode></Product>' }
  ];

  for (const envelope of envelopes) {
    const result = await adapter.mapProduct(envelope);
    assert.deepEqual(result, { statusCode: 200, body: canonicalResponse });
  }
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, 'http://127.0.0.1:3400/api/v1/mapping/products');
    assert.equal(request.options.method, 'POST');
  }
  assert.deepEqual(JSON.parse(requests[0].options.body), envelopes[0]);
  assert.deepEqual(JSON.parse(requests[1].options.body), envelopes[1]);
});

test('adapter rejects invalid envelopes before calling Python', async () => {
  let called = false;
  const adapter = new DataMappingAdapter({
    serviceUrl: 'http://127.0.0.1:3400',
    timeoutMs: 1000,
    fetchImpl: async () => { called = true; }
  });

  await assert.rejects(
    adapter.mapProduct({ format: 'xml', payload: { not: 'XML text' } }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_MAPPING_REQUEST'
  );
  assert.equal(called, false);
});

test('adapter maps internal service connection errors and timeouts', async () => {
  const unavailable = new DataMappingAdapter({
    serviceUrl: 'http://127.0.0.1:3400',
    timeoutMs: 1000,
    fetchImpl: async () => { throw new Error('connection refused'); }
  });
  await assert.rejects(
    unavailable.mapProduct({ format: 'json', payload: { ProductCode: 'SKU-0001' } }),
    (error) => error.statusCode === 503 && error.code === 'MAPPING_SERVICE_UNAVAILABLE'
  );

  const timeout = new DataMappingAdapter({
    serviceUrl: 'http://127.0.0.1:3400',
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })
  });
  await assert.rejects(
    timeout.mapProduct({ format: 'json', payload: { ProductCode: 'SKU-0001' } }),
    (error) => error.statusCode === 504 && error.code === 'MAPPING_SERVICE_TIMEOUT'
  );
});
