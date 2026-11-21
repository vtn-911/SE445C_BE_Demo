const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createDashboardApp } = require('../src/dashboard/app');
const { DockerMonitor } = require('../src/dashboard/docker-monitor');
const { RabbitMqMonitor } = require('../src/dashboard/rabbitmq-monitor');
const { StateReader } = require('../src/dashboard/state-reader');
const { EventHub } = require('../src/dashboard/event-hub');
const { readKongRateLimitConfig } = require('../src/dashboard/kong-config-reader');

function signTestJwt(payload, secret) {
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  const s = crypto
    .createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${h}.${p}.${s}`;
}

async function startTestServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('Dashboard Backend unit & integration suite', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-dash-test-'));
  await fs.mkdir(path.join(tmpDir, 'tms'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'orders.json'),
    JSON.stringify({
      orders: [
        { orderId: 'ord-1', customerId: 'C1', status: 'accepted', createdAt: new Date().toISOString() },
        { orderId: 'ord-2', customerId: 'C2', status: 'accepted', createdAt: new Date().toISOString() },
      ],
      outbox: [
        { event: { eventId: 'evt-1', eventType: 'order.created', data: { orderId: 'ord-1' } }, publishedAt: '2026-11-21T10:00:00Z' },
        { event: { eventId: 'evt-2', eventType: 'order.created', data: { orderId: 'ord-2' } }, publishedAt: null },
      ],
    })
  );
  await fs.writeFile(
    path.join(tmpDir, 'tms', 'shipments.json'),
    JSON.stringify({
      shipments: [
        { shipmentId: 'shp-1', eventId: 'evt-1', orderId: 'ord-1', status: 'created', createdAt: '2026-11-21T10:00:01Z' },
      ],
    })
  );

  const testSecret = 'unit-test-only-secret-value';
  const eventHub = new EventHub(50);

  let mockDockerFail = false;
  let tmsState = 'running';
  const dockerCalls = [];
  const dockerMonitor = new DockerMonitor({
    composeFile: path.resolve(__dirname, '../docker-compose.yml'),
    cacheTtlMs: 0,
    execFn: async (cmd, args) => {
      dockerCalls.push({ cmd, args });
      if (mockDockerFail) throw new Error('Docker daemon not running');
      if (args.includes('stop') || args.includes('start')) {
        tmsState = args.includes('stop') ? 'exited' : 'running';
        return { stdout: '' };
      }
      const list = [
        { Service: 'kong', State: 'running', Health: 'healthy', Status: 'Up 1h (healthy)' },
        { Service: 'backend', State: 'running', Health: 'healthy', Status: 'Up 1h (healthy)' },
        { Service: 'rabbitmq', State: 'running', Health: 'healthy', Status: 'Up 1h (healthy)' },
        { Service: 'mock-wms', State: 'running', Health: 'healthy', Status: 'Up 1h (healthy)' },
        { Service: 'mock-tms', State: tmsState, Health: tmsState === 'running' ? 'healthy' : '', Status: tmsState },
        { Service: 'mock-crm', State: 'running', Health: 'unhealthy', Status: 'Up 1h (unhealthy)' },
        { Service: 'python-mapping', State: 'running', Health: 'healthy', Status: 'Up 1h (healthy)' },
        { Service: 'batch-receiver', State: 'running', Health: 'healthy', Status: 'Up 1h (healthy)' },
      ];
      return { stdout: JSON.stringify(list) };
    },
    eventHub,
  });

  let mockRabbitFail = false;
  const rabbitmqMonitor = new RabbitMqMonitor({
    baseUrl: 'http://127.0.0.1:15672',
    user: 'test',
    pass: 'test',
    fetchFn: async (url) => {
      if (mockRabbitFail) throw new Error('RabbitMQ connection refused');
      if (url.endsWith('/api/queues/%2F')) {
        return {
          ok: true,
          json: async () => [
            { name: 'payment.order-created', messages_ready: 0, messages_unacknowledged: 0, consumers: 1 },
            { name: 'wms.order-created', messages_ready: 1, messages_unacknowledged: 0, consumers: 1 },
            { name: 'wms.order-created.retry', messages_ready: 0, messages_unacknowledged: 0, consumers: 0 },
            { name: 'notification.order-created', messages_ready: 0, messages_unacknowledged: 0, consumers: 1 },
            { name: 'tms.order-created', messages_ready: 0, messages_unacknowledged: 0, consumers: 1 },
            { name: 'tms.order-created.retry', messages_ready: 2, messages_unacknowledged: 0, consumers: 0 },
            { name: 'tms.order-created.dlq', messages_ready: 3, messages_unacknowledged: 0, consumers: 0 },
          ],
        };
      }
      return {
        ok: true,
        json: async () => ({
          name: 'tms.order-created.dlq',
          messages: 3,
          messages_ready: 3,
          messages_unacknowledged: 0,
          consumers: 0,
          state: 'running',
        }),
      };
    },
    eventHub,
  });

  const stateReader = new StateReader(tmpDir);
  const config = {
    corsOrigin: 'http://localhost:5173',
    kongConfigPath: path.resolve(__dirname, '../kong/kong.yml'),
    rateLimitWindowMs: 60000,
    rateLimitMax: 100,
    jwt: { secret: testSecret, issuer: 'abc-retail-demo' },
  };

  const app = createDashboardApp({
    config,
    dockerMonitor,
    rabbitmqMonitor,
    stateReader,
    eventHub,
  });
  const srv = await startTestServer(app);

  t.after(async () => {
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await t.test('GET /api/dashboard/health distinguishes ONLINE, UNHEALTHY, OFFLINE, and UNKNOWN', async () => {
    mockDockerFail = false;
    tmsState = 'exited';
    const res = await fetch(`${srv.baseUrl}/api/dashboard/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const byName = new Map(body.services.map((s) => [s.name, s]));
    assert.equal(byName.get('kong').status, 'ONLINE');
    assert.equal(byName.get('mock-tms').status, 'OFFLINE');
    assert.equal(byName.get('mock-crm').status, 'UNHEALTHY');

    mockDockerFail = true;
    const resUnknown = await fetch(`${srv.baseUrl}/api/dashboard/health`);
    const bodyUnknown = await resUnknown.json();
    assert.equal(bodyUnknown.dockerAvailable, false);
    assert.ok(bodyUnknown.services.every((s) => s.status === 'UNKNOWN'));
    mockDockerFail = false;
    tmsState = 'running';
  });

  await t.test('GET /api/dashboard/overview aggregates real counts', async () => {
    const res = await fetch(`${srv.baseUrl}/api/dashboard/overview`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalServices, 8);
    assert.equal(body.totalOrders, 2);
    assert.equal(body.dlqMessages, 3);
    assert.equal(body.errorRate, undefined);
  });

  await t.test('GET /api/dashboard/rabbitmq/queues & DLQ metadata safety', async () => {
    const qRes = await fetch(`${srv.baseUrl}/api/dashboard/rabbitmq/queues`);
    assert.equal(qRes.status, 200);
    const qBody = await qRes.json();
    const tms = qBody.queues.find((q) => q.name === 'tms.order-created');
    assert.equal(tms.dlqCount, 3);

    const badDlq = await fetch(`${srv.baseUrl}/api/dashboard/rabbitmq/dlq/arbitrary.queue/messages`);
    assert.equal(badDlq.status, 400);

    const okDlq = await fetch(`${srv.baseUrl}/api/dashboard/rabbitmq/dlq/tms.order-created.dlq/messages`);
    assert.equal(okDlq.status, 200);
    const dlqBody = await okDlq.json();
    assert.equal(dlqBody.messageCount, 3);
    assert.equal(dlqBody.payloadInspectionSupported, false);

    mockRabbitFail = true;
    const errRes = await fetch(`${srv.baseUrl}/api/dashboard/rabbitmq/queues`);
    assert.equal(errRes.status, 502);
    mockRabbitFail = false;
  });

  await t.test('GET /api/dashboard/kong/rate-limit reads actual kong/kong.yml', async () => {
    const direct = await readKongRateLimitConfig(config.kongConfigPath);
    assert.equal(direct.minute, 100);

    const res = await fetch(`${srv.baseUrl}/api/dashboard/kong/rate-limit`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.minute, 100);
    assert.equal(body.limitBy, 'ip');
    assert.equal(body.policy, 'local');
  });

  await t.test('GET /api/dashboard/scenarios/orders/:orderId/trace reflects real evidence', async () => {
    const okRes = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/orders/ord-1/trace`);
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.steps.wmsChecked, 'SUCCESS');
    assert.equal(okBody.steps.eventPublished, 'SUCCESS');
    assert.equal(okBody.steps.tmsCreated, 'SUCCESS');

    const pendingRes = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/orders/ord-2/trace`);
    assert.equal(pendingRes.status, 200);
    const pendingBody = await pendingRes.json();
    assert.equal(pendingBody.steps.eventPublished, 'PENDING');
    assert.equal(pendingBody.steps.tmsCreated, 'PENDING');

    const missingRes = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/orders/does-not-exist/trace`);
    assert.equal(missingRes.status, 404);
  });

  await t.test('POST /api/dashboard/scenarios/tms/stop|start enforces JWT and targets only mock-tms', async () => {
    const noAuth = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/tms/stop`, { method: 'POST' });
    assert.equal(noAuth.status, 401);

    const wrongIssToken = signTestJwt(
      { iss: 'wrong-issuer', exp: Math.floor(Date.now() / 1000) + 60 },
      testSecret
    );
    const forbidden = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/tms/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${wrongIssToken}` },
    });
    assert.equal(forbidden.status, 403);

    const validToken = signTestJwt(
      { iss: 'abc-retail-demo', exp: Math.floor(Date.now() / 1000) + 60 },
      testSecret
    );
    const stopRes = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/tms/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.equal(stopRes.status, 200);
    const stopBody = await stopRes.json();
    assert.equal(stopBody.service, 'mock-tms');
    assert.equal(stopBody.status, 'OFFLINE');

    const stopCall = [...dockerCalls].reverse().find((c) => c.args.includes('stop'));
    assert.ok(stopCall);
    assert.equal(stopCall.args[stopCall.args.length - 1], 'mock-tms');

    const startRes = await fetch(`${srv.baseUrl}/api/dashboard/scenarios/tms/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json();
    assert.equal(startBody.status, 'ONLINE');
  });

  await t.test('GET /api/dashboard/events/stream delivers SSE events and cleans up on disconnect', async () => {
    const controller = new AbortController();
    const res = await fetch(`${srv.baseUrl}/api/dashboard/events/stream`, {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    eventHub.push({
      id: 'sse-test-1',
      type: 'ORDER_CREATED',
      service: 'backend',
      status: 'SUCCESS',
      message: 'SSE test event',
    });

    let collected = '';
    while (!collected.includes('sse-test-1')) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += decoder.decode(value, { stream: true });
    }
    assert.match(collected, /sse-test-1/);
    controller.abort();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(eventHub.clients.size, 0);
  });
});
