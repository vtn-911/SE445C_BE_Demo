const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { InventoryService } = require('../src/services/inventory-service');
const { InventoryAdapter, WmsIntegrationError } = require('../src/integrations/wms/inventory-adapter');

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

test('inventory Process API returns current stock from the WMS adapter', async () => {
  const app = createApp({
    inventoryService: new InventoryService({
      getInventory: async (sku) => ({ sku, availableQuantity: 50 })
    })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/inventory/SKU123`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: { sku: 'SKU123', availableQuantity: 50 }
    });
  });
});

test('inventory Process API reports a missing SKU', async () => {
  const app = createApp({
    inventoryService: new InventoryService({
      getInventory: async () => { throw new WmsIntegrationError(404, 'SKU_NOT_FOUND', 'Missing SKU'); }
    })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/inventory/UNKNOWN`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'SKU_NOT_FOUND');
  });
});

test('product stock API resolves the Product ID to its catalog SKU', async () => {
  const requestedSkus = [];
  const app = createApp({
    inventoryService: new InventoryService({
      getInventory: async (sku) => {
        requestedSkus.push(sku);
        return { sku, availableQuantity: 50 };
      }
    })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/products/SKU-0001/stock`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: {
        productId: 'SKU-0001',
        sku: 'SKU-0001',
        availableQuantity: 50
      }
    });
    assert.deepEqual(requestedSkus, ['SKU-0001']);
  });
});

test('product stock API returns 404 without calling WMS for an unknown Product ID', async () => {
  let inventoryLookups = 0;
  const app = createApp({
    inventoryService: new InventoryService({
      getInventory: async () => {
        inventoryLookups += 1;
        return { sku: 'UNKNOWN', availableQuantity: 0 };
      }
    })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/products/UNKNOWN/stock`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'PRODUCT_NOT_FOUND');
    assert.equal(inventoryLookups, 0);
  });
});

test('product stock API preserves WMS not-found errors for a catalog Product ID', async () => {
  const app = createApp({
    inventoryService: new InventoryService({
      getInventory: async () => {
        throw new WmsIntegrationError(404, 'SKU_NOT_FOUND', 'Missing SKU');
      }
    })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/products/SKU-0001/stock`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'SKU_NOT_FOUND');
  });
});

test('HTTP WMS adapter rejects malformed inventory data', async () => {
  const adapter = new InventoryAdapter({
    mode: 'http',
    baseUrl: 'http://wms.local',
    timeoutMs: 100,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ sku: 'SKU123', availableQuantity: -1 })
    })
  });

  await assert.rejects(
    adapter.getInventory('SKU123'),
    (error) => error.code === 'WMS_INVALID_RESPONSE' && error.statusCode === 502
  );
});

test('HTTP WMS adapter maps an unresponsive WMS to a gateway timeout', async () => {
  const adapter = new InventoryAdapter({
    mode: 'http',
    baseUrl: 'http://wms.local',
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })
  });

  await assert.rejects(
    adapter.getInventory('SKU123'),
    (error) => error.code === 'WMS_TIMEOUT' && error.statusCode === 504
  );
});
