const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createDashboardApp } = require('../src/dashboard/app');
const { StateReader } = require('../src/dashboard/state-reader');
const { EventHub } = require('../src/dashboard/event-hub');

// Fixtures mirror what the Backend really persists:
// OrderService.create -> event = { eventId, eventType, occurredAt, data: order }
// OrdersRepository.create -> outbox entry = { event, publishedAt: null }
function makeOrder(orderId, createdAt = '2026-11-21T10:00:00.000Z') {
  return { orderId, customerId: 'C', items: [{ sku: 'SKU123', quantity: 1 }], status: 'accepted', createdAt };
}
function makeEntry(orderId, eventId, publishedAt) {
  return {
    event: { eventId, eventType: 'order.created', occurredAt: '2026-11-21T10:00:00.000Z', data: makeOrder(orderId) },
    publishedAt,
  };
}
function makeShipment(shipmentId, eventId, orderId, status = 'created') {
  return { shipmentId, eventId, orderId, status, createdAt: '2026-11-21T10:00:02.000Z' };
}

async function setup({ orders = [], outbox = [], shipments = [], tmsProcessed = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-trace-test-'));
  const write = async ({ orders, outbox, shipments, tmsProcessed }) => {
    await fs.mkdir(path.join(dir, 'tms'), { recursive: true });
    await fs.mkdir(path.join(dir, 'consumers'), { recursive: true });
    await fs.writeFile(path.join(dir, 'orders.json'), JSON.stringify({ orders, outbox }));
    await fs.writeFile(path.join(dir, 'tms', 'shipments.json'), JSON.stringify({ shipments }));
    await fs.writeFile(path.join(dir, 'consumers', 'tms.json'), JSON.stringify({ processedEventIds: tmsProcessed }));
  };
  await write({ orders, outbox, shipments, tmsProcessed });
  return { dir, write, reader: new StateReader(dir), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const NOW = Date.parse('2026-11-21T10:00:10.000Z');

test('1. order + published event + shipment -> all SUCCESS with linked IDs', async () => {
  const s = await setup({
    orders: [makeOrder('o1')],
    outbox: [makeEntry('o1', 'e1', '2026-11-21T10:00:01.000Z')],
    shipments: [makeShipment('s1', 'e1', 'o1')],
    tmsProcessed: ['e1'],
  });
  const t = await s.reader.traceOrder('o1', NOW);
  assert.equal(t.eventId, 'e1');
  assert.equal(t.shipmentId, 's1');
  assert.deepEqual(
    [t.steps.wmsChecked, t.steps.eventPublished, t.steps.tmsCreated],
    ['SUCCESS', 'SUCCESS', 'SUCCESS']
  );
  assert.match(t.steps.eventDetail, /e1/);
  assert.match(t.steps.tmsDetail, /s1/);
  await s.cleanup();
});

test('2. order exists but event not yet published -> event PENDING, TMS PENDING (not SUCCESS)', async () => {
  const s = await setup({ orders: [makeOrder('o1')], outbox: [makeEntry('o1', 'e1', null)] });
  const t = await s.reader.traceOrder('o1', NOW);
  assert.equal(t.steps.eventPublished, 'PENDING');
  assert.equal(t.steps.tmsCreated, 'PENDING');
  assert.equal(t.shipmentId, null);
  await s.cleanup();
});

test('2b. order without any outbox entry -> UNKNOWN with explanation', async () => {
  const s = await setup({ orders: [makeOrder('o1')] });
  const t = await s.reader.traceOrder('o1', NOW);
  assert.equal(t.steps.eventPublished, 'UNKNOWN');
  assert.equal(t.steps.tmsCreated, 'UNKNOWN');
  assert.match(t.steps.eventDetail, /No outbox entry/);
  await s.cleanup();
});

test('3. event published, TMS not processed yet -> event SUCCESS, TMS PENDING', async () => {
  const s = await setup({
    orders: [makeOrder('o1')],
    outbox: [makeEntry('o1', 'e1', '2026-11-21T10:00:05.000Z')],
  });
  const t = await s.reader.traceOrder('o1', NOW);
  assert.equal(t.steps.eventPublished, 'SUCCESS');
  assert.equal(t.steps.tmsCreated, 'PENDING');
  await s.cleanup();
});

test('3b. published long ago without shipment -> UNKNOWN (no invented failure/success)', async () => {
  const s = await setup({
    orders: [makeOrder('o1')],
    outbox: [makeEntry('o1', 'e1', '2026-11-21T09:00:00.000Z')],
  });
  const t = await s.reader.traceOrder('o1', NOW);
  assert.equal(t.steps.eventPublished, 'SUCCESS');
  assert.equal(t.steps.tmsCreated, 'UNKNOWN');
  assert.match(t.steps.tmsDetail, /Retry\/DLQ/);
  await s.cleanup();
});

test('4. shipment recorded with failed status -> TMS FAILED; consumer record without shipment -> UNKNOWN', async () => {
  const s = await setup({
    orders: [makeOrder('o1'), makeOrder('o2')],
    outbox: [
      makeEntry('o1', 'e1', '2026-11-21T10:00:01.000Z'),
      makeEntry('o2', 'e2', '2026-11-21T10:00:01.000Z'),
    ],
    shipments: [makeShipment('s1', 'e1', 'o1', 'failed')],
    tmsProcessed: ['e2'],
  });
  const failed = await s.reader.traceOrder('o1', NOW);
  assert.equal(failed.steps.tmsCreated, 'FAILED');
  const odd = await s.reader.traceOrder('o2', NOW);
  assert.equal(odd.steps.tmsCreated, 'UNKNOWN');
  await s.cleanup();
});

test('5. unknown order id -> null from reader and 404 from API, never SUCCESS', async () => {
  const s = await setup({ orders: [makeOrder('o1')], outbox: [makeEntry('o1', 'e1', '2026-11-21T10:00:01.000Z')] });
  const srv = await startApp(s.reader);
  try {
    assert.equal(await s.reader.traceOrder('missing', NOW), null);
    const res = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/orders/missing/trace`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.steps, undefined);
  } finally {
    await srv.close();
    await s.cleanup();
  }
});

test('7. two orders never share Event or Shipment', async () => {
  const s = await setup({
    orders: [makeOrder('o1'), makeOrder('o2')],
    outbox: [
      makeEntry('o1', 'e1', '2026-11-21T10:00:01.000Z'),
      makeEntry('o2', 'e2', '2026-11-21T10:00:01.000Z'),
    ],
    shipments: [makeShipment('s1', 'e1', 'o1')],
    tmsProcessed: ['e1'],
  });
  const a = await s.reader.traceOrder('o1', NOW);
  const b = await s.reader.traceOrder('o2', NOW);
  assert.equal(a.eventId, 'e1');
  assert.equal(a.shipmentId, 's1');
  assert.equal(b.eventId, 'e2');
  assert.equal(b.shipmentId, null);
  assert.equal(b.steps.tmsCreated, 'PENDING');
  await s.cleanup();
});

function startApp(stateReader) {
  const app = createDashboardApp({
    config: {
      corsOrigin: 'http://localhost:5173',
      kongConfigPath: '',
      rateLimitWindowMs: 60000,
      rateLimitMax: 1000,
      jwt: { secret: 'unit-test-only-secret-value', issuer: 'abc-retail-demo' },
    },
    dockerMonitor: {},
    rabbitmqMonitor: {},
    stateReader,
    eventHub: new EventHub(10),
  });
  const server = http.createServer(app);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.();
          }),
      })
    )
  );
}

test('6. polling the trace endpoint reflects async progress (PENDING -> SUCCESS)', async () => {
  const order = makeOrder('o1');
  const s = await setup({ orders: [order], outbox: [makeEntry('o1', 'e1', null)] });
  const srv = await startApp(s.reader);
  try {
    const url = `${srv.baseUrl}/api/dashboard/scenarios/orders/o1/trace`;

    let body = await (await fetch(url)).json();
    assert.equal(body.steps.eventPublished, 'PENDING');

    const publishedAt = new Date().toISOString();
    await s.write({
      orders: [order],
      outbox: [makeEntry('o1', 'e1', publishedAt)],
      shipments: [],
      tmsProcessed: [],
    });
    body = await (await fetch(url)).json();
    assert.equal(body.steps.eventPublished, 'SUCCESS');
    assert.equal(body.steps.tmsCreated, 'PENDING');

    await s.write({
      orders: [order],
      outbox: [makeEntry('o1', 'e1', publishedAt)],
      shipments: [makeShipment('s1', 'e1', 'o1')],
      tmsProcessed: ['e1'],
    });
    body = await (await fetch(url)).json();
    assert.equal(body.steps.tmsCreated, 'SUCCESS');
    assert.equal(body.shipmentId, 's1');
    assert.equal(body.eventId, 'e1');
  } finally {
    await srv.close();
    await s.cleanup();
  }
});
