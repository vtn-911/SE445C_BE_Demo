const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createMockCrmApp } = require('../src/mocks/crm/app');
const { CustomersRepository } = require('../src/repositories/customers-repository');

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-retail-crm-test-'));
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

test('Mock CRM exposes health and replaces points idempotently for a seeded customer', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = new CustomersRepository(directory);
    const app = createMockCrmApp({ customersRepository: repository });

    await withServer(app, async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { success: true, status: 'ok' });

      const url = `${baseUrl}/api/v1/crm/customers/CUST-0001/points`;
      const options = {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ points: 125 })
      };
      const first = await fetch(url, options);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), {
        success: true,
        data: { customerId: 'CUST-0001', points: 125 }
      });

      const repeated = await fetch(url, options);
      assert.equal(repeated.status, 200);
      assert.deepEqual(await repeated.json(), {
        success: true,
        data: { customerId: 'CUST-0001', points: 125 }
      });
    });

    const savedState = JSON.parse(
      await fs.readFile(path.join(directory, 'crm', 'customers.json'), 'utf8')
    );
    assert.equal(savedState.customers.find((item) => item.customerId === 'CUST-0001').points, 125);
  });
});

test('Mock CRM returns 404 for customers absent from the demo seed', async () => {
  await withTemporaryDirectory(async (directory) => {
    const app = createMockCrmApp({
      customersRepository: new CustomersRepository(directory)
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/crm/customers/UNKNOWN/points`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ points: 10 })
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, 'CUSTOMER_NOT_FOUND');
    });
  });
});

test('Mock CRM rejects malformed or unsafe points updates', async () => {
  await withTemporaryDirectory(async (directory) => {
    const app = createMockCrmApp({
      customersRepository: new CustomersRepository(directory)
    });
    const invalidBodies = [
      {},
      { points: -1 },
      { points: 1.5 },
      { points: '10' },
      { points: Number.MAX_SAFE_INTEGER + 1 },
      { points: 10, extra: true }
    ];

    await withServer(app, async (baseUrl) => {
      for (const body of invalidBodies) {
        const response = await fetch(`${baseUrl}/api/v1/crm/customers/CUST-0001/points`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'INVALID_POINTS');
      }
    });
  });
});
