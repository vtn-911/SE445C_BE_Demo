const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { InventoryAdapter } = require('../src/integrations/wms/inventory-adapter');
const { TmsShipmentAdapter } = require('../src/integrations/tms/shipment-adapter');
const { createWmsMockApp } = require('../src/mocks/wms/app');
const { createTmsMockApp } = require('../src/mocks/tms/app');
const { ShipmentsRepository } = require('../src/repositories/shipments-repository');
const { createHandlers } = require('../src/messaging/order-consumers');
const { RabbitMqRuntime } = require('../src/messaging/rabbitmq-runtime');
const { consumers, assertTopology } = require('../src/messaging/topology');

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-retail-mocks-'));
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

test('HTTP WMS adapter reads the Mock WMS endpoint and preserves not-found behavior', async () => {
  const app = createWmsMockApp({ inventory: { SKU123: 7 } });

  await withServer(app, async (baseUrl) => {
    const adapter = new InventoryAdapter({
      mode: 'http',
      baseUrl: `${baseUrl}/api/v1/wms`,
      timeoutMs: 1000
    });

    assert.deepEqual(await adapter.getInventory('SKU123'), {
      sku: 'SKU123',
      availableQuantity: 7
    });
    await assert.rejects(
      adapter.getInventory('UNKNOWN'),
      (error) => error.statusCode === 404 && error.code === 'SKU_NOT_FOUND'
    );
  });
});

test('TMS consumer creates one shipment over HTTP and ACKs duplicate event deliveries', async () => {
  await withTemporaryDirectory(async (directory) => {
    const shipmentsRepository = new ShipmentsRepository(path.join(directory, 'tms'));
    const tmsApp = createTmsMockApp({ shipmentsRepository });

    await withServer(tmsApp, async (baseUrl) => {
      const tmsAdapter = new TmsShipmentAdapter({
        baseUrl: `${baseUrl}/api/v1/tms`,
        timeoutMs: 1000
      });
      const handlers = createHandlers({ stateDir: directory, tmsAdapter });
      const consumer = consumers.find((item) => item.name === 'tms');
      const event = {
        eventId: 'event-test-1',
        eventType: 'order.created',
        occurredAt: new Date().toISOString(),
        data: {
          orderId: 'order-test-1',
          customerId: 'customer-test-1',
          items: [{ sku: 'SKU123', quantity: 2 }]
        }
      };
      const message = {
        content: Buffer.from(JSON.stringify(event)),
        properties: { messageId: event.eventId, headers: {} }
      };
      const acknowledgements = [];
      const channel = { ack: (ackedMessage) => acknowledgements.push(ackedMessage) };
      const runtime = new RabbitMqRuntime({
        url: '',
        reconnectMs: 1,
        retryDelayMs: 5,
        stateDir: directory,
        failSku: '',
        tmsAdapter
      });

      await runtime.processMessage(channel, consumer, handlers[consumer.queue], message);
      await runtime.processMessage(channel, consumer, handlers[consumer.queue], message);

      const shipments = await shipmentsRepository.list();
      assert.equal(acknowledgements.length, 2);
      assert.equal(shipments.length, 1);
      assert.equal(shipments[0].eventId, event.eventId);
      assert.equal(shipments[0].orderId, event.data.orderId);
      assert.equal(shipments[0].status, 'created');
    });
  });
});

test('RabbitMQ topology declares an isolated TMS retry queue and return binding', async () => {
  const exchanges = [];
  const queues = [];
  const bindings = [];
  const channel = {
    assertExchange: async (...args) => exchanges.push(args),
    assertQueue: async (...args) => queues.push(args),
    bindQueue: async (...args) => bindings.push(args)
  };

  await assertTopology(channel, 5000);

  assert.ok(exchanges.some(([name]) => name === 'abc.tms.retry'));
  assert.ok(queues.some(([name, options]) =>
    name === 'tms.order-created.retry' &&
    options.arguments['x-message-ttl'] === 5000 &&
    options.arguments['x-dead-letter-exchange'] === 'abc.tms.retry'
  ));
  assert.ok(bindings.some(([queue, exchange, routingKey]) =>
    queue === 'tms.order-created' &&
    exchange === 'abc.tms.retry' &&
    routingKey === 'tms.order-created'
  ));
  assert.ok(queues.some(([name, options]) =>
    name === 'wms.order-created.retry' &&
    options.arguments['x-dead-letter-exchange'] === 'abc.wms.retry'
  ));
});

test('TMS failures route to TMS retry and then TMS DLQ; non-retry consumers go directly to DLQ', async () => {
  const runtime = new RabbitMqRuntime({
    url: '',
    reconnectMs: 1,
    retryDelayMs: 5000,
    stateDir: '',
    failSku: ''
  });
  const published = [];
  runtime.confirmChannel = {
    sendToQueue: (queue, content, options) => published.push({ queue, content, options }),
    waitForConfirms: async () => {}
  };
  const acknowledgements = [];
  const channel = {
    ack: (message) => acknowledgements.push({ message }),
    nack: (message, allUpTo, requeue) => acknowledgements.push({ message, allUpTo, requeue })
  };
  const tmsConsumer = consumers.find((item) => item.name === 'tms');
  const paymentConsumer = consumers.find((item) => item.name === 'payment');
  const makeMessage = (retryCount) => ({
    content: Buffer.from('event'),
    properties: {
      messageId: 'event-test',
      headers: retryCount === undefined ? {} : { 'x-retry-count': retryCount }
    }
  });

  await runtime.routeFailedMessage(channel, tmsConsumer, makeMessage(0), new Error('TMS unavailable'));
  await runtime.routeFailedMessage(channel, tmsConsumer, makeMessage(3), new Error('TMS unavailable'));
  await runtime.routeFailedMessage(channel, paymentConsumer, makeMessage(0), new Error('Payment failed'));

  assert.deepEqual(published.map((entry) => entry.queue), [
    'tms.order-created.retry',
    'tms.order-created.dlq',
    'payment.order-created.dlq'
  ]);
  assert.equal(published[0].options.headers['x-retry-count'], 1);
  assert.equal(published[1].options.headers['x-retry-count'], 3);
  assert.equal(acknowledgements.length, 3);
});

test('failed retry publishing rejects the original to its configured DLX instead of requeueing indefinitely', async () => {
  const runtime = new RabbitMqRuntime({
    url: '',
    reconnectMs: 1,
    retryDelayMs: 5000,
    stateDir: '',
    failSku: ''
  });
  runtime.confirmChannel = {
    sendToQueue: () => {},
    waitForConfirms: async () => { throw new Error('confirm failed'); }
  };
  let nackArgs;
  const channel = {
    ack: () => assert.fail('original message must not be acknowledged'),
    nack: (...args) => { nackArgs = args; }
  };
  const consumer = consumers.find((item) => item.name === 'tms');
  const message = {
    content: Buffer.from('event'),
    properties: { messageId: 'event-test', headers: {} }
  };

  await runtime.routeFailedMessage(channel, consumer, message, new Error('TMS unavailable'));

  assert.deepEqual(nackArgs, [message, false, false]);
});
