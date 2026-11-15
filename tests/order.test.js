const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { OrdersRepository } = require('../src/repositories/orders-repository');
const { ConsumerEventsRepository } = require('../src/repositories/consumer-events-repository');
const { OrderService } = require('../src/services/order-service');
const { OutboxPublisher } = require('../src/services/outbox-publisher');
const { MAX_RETRIES, nextFailureAction } = require('../src/messaging/retry-policy');

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-retail-test-'));
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

test('order API persists an order and outbox event before returning 202', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = new OrdersRepository(directory);
    const orderService = new OrderService({
      ordersRepository: repository,
      notifyOutbox: () => {}
    });
    const app = createApp({ orderService });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: 'customer-1',
          items: [{ sku: 'SKU123', quantity: 2 }]
        })
      });
      assert.equal(response.status, 202);
      const { data } = await response.json();
      assert.equal(data.status, 'accepted');
      assert.equal((await repository.listOrders()).length, 1);
      const pending = await repository.listPendingEvents();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].event.eventType, 'order.created');
    });
  });
});

test('outbox leaves the event pending when RabbitMQ publishing fails', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = new OrdersRepository(directory);
    const service = new OrderService({ ordersRepository: repository, notifyOutbox: () => {} });
    await service.create({ customerId: 'customer-2', items: [{ sku: 'SKU123', quantity: 1 }] });
    const publisher = new OutboxPublisher({
      ordersRepository: repository,
      publish: async () => { throw new Error('broker unavailable'); }
    });

    await assert.rejects(publisher.flush(), /broker unavailable/);
    assert.equal((await repository.listPendingEvents()).length, 1);
  });
});

test('consumer event storage deduplicates successful processing but retries failed work', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = new ConsumerEventsRepository(directory, 'payment');
    let runs = 0;
    await assert.rejects(repository.processOnce('event-1', async () => {
      runs += 1;
      throw new Error('temporary payment failure');
    }));

    assert.equal(await repository.processOnce('event-1', async () => { runs += 1; }), true);
    assert.equal(await repository.processOnce('event-1', async () => { runs += 1; }), false);
    assert.equal(runs, 2);
  });
});

test('WMS retry policy allows three retries after the initial attempt, then dead-letters', () => {
  assert.equal(MAX_RETRIES, 3);
  assert.equal(nextFailureAction(0), 'retry');
  assert.equal(nextFailureAction(1), 'retry');
  assert.equal(nextFailureAction(2), 'retry');
  assert.equal(nextFailureAction(3), 'dead-letter');
  assert.throws(() => nextFailureAction(-1), /non-negative integer/);
});
