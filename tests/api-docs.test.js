const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createApp } = require('../src/app');

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

test('public OpenAPI document includes the CRM contract but omits internal services', async () => {
  const app = createApp({
    inventoryService: { lookup: async () => ({ sku: 'SKU123', availableQuantity: 50 }) }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(response.status, 200);
    const document = await response.json();

    assert.ok(document.paths['/api/v1/crm/customers/{id}/points'].put);
    assert.ok(document.paths['/api/v1/products/{id}/stock'].get);
    assert.ok(document.paths['/api/v1/orders'].post);
    assert.ok(document.paths['/api/v1/data-mapping/products'].post);
    assert.equal(document.paths['/api/v1/wms/inventory/{sku}'], undefined);
    assert.equal(document.paths['/api/v1/tms/shipments'], undefined);
    assert.equal(document.paths['/api/v1/mapping/products'], undefined);
  });
});

test('Swagger UI is served with the public OpenAPI document', async () => {
  const app = createApp({
    inventoryService: { lookup: async () => ({ sku: 'SKU123', availableQuantity: 50 }) }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/docs/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /swagger-ui/);
  });
});
