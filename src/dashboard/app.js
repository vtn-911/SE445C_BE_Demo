const express = require('express');
const { readKongRateLimitConfig } = require('./kong-config-reader');
const { createJwtAuthMiddleware } = require('./jwt-auth');
const logger = require('../logger');

function createRateLimiter({ windowMs = 60000, max = 180 }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'local';
    const now = Date.now();
    const record = hits.get(key);
    if (!record || now >= record.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    record.count += 1;
    if (record.count > max) {
      return res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests to Dashboard API' },
      });
    }
    return next();
  };
}

function createDashboardApp({
  config,
  dockerMonitor,
  rabbitmqMonitor,
  stateReader,
  eventHub,
  readRateLimit = readKongRateLimitConfig,
  authMiddleware,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Strict CORS for Frontend origin only
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  });

  app.use('/api/dashboard', createRateLimiter({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax }));

  const requireAuth = authMiddleware || createJwtAuthMiddleware(config.jwt);

  app.get('/health', (req, res) => {
    res.json({ success: true, status: 'ok', service: 'dashboard-backend' });
  });

  app.get('/api/dashboard/health', async (req, res) => {
    try {
      const health = await dockerMonitor.getHealth();
      res.json(health);
    } catch (err) {
      res.status(503).json({
        success: false,
        error: { code: 'DOCKER_UNAVAILABLE', message: err.message },
      });
    }
  });

  app.get('/api/dashboard/overview', async (req, res) => {
    try {
      const [health, orderMetrics, rabbitSummary] = await Promise.all([
        dockerMonitor.getHealth().catch(() => null),
        stateReader.getOrderMetrics().catch(() => null),
        rabbitmqMonitor.getQueuesSummary().catch(() => null),
      ]);

      const services = health?.services || [];
      const totalServices = services.length > 0 ? services.length : null;
      const onlineServices = services.length > 0 ? services.filter((s) => s.status === 'ONLINE').length : null;
      const offlineServices = services.length > 0 ? services.filter((s) => s.status === 'OFFLINE').length : null;

      const queues = rabbitSummary?.queues || null;
      const totalQueueMessages = queues
        ? queues.reduce((sum, q) => sum + (q.ready || 0) + (q.unacked || 0), 0)
        : null;
      const dlqMessages = queues ? queues.reduce((sum, q) => sum + (q.dlqCount || 0), 0) : null;

      res.json({
        totalServices,
        onlineServices,
        offlineServices,
        totalOrders: orderMetrics?.totalOrders ?? null,
        throughputPerMin: orderMetrics?.throughputPerMin ?? null,
        totalQueueMessages,
        dlqMessages,
        // No reliable HTTP error-rate denominator exists in current Business Backend
        errorRate: undefined,
        throughputSeries: orderMetrics?.throughputSeries ?? [],
        requestCounts: null,
      });
    } catch {
      res.status(500).json({
        success: false,
        error: { code: 'OVERVIEW_FAILED', message: 'Failed to aggregate overview metrics' },
      });
    }
  });

  app.get('/api/dashboard/rabbitmq/queues', async (req, res) => {
    try {
      const summary = await rabbitmqMonitor.getQueuesSummary();
      res.json(summary);
    } catch (err) {
      const status = err.status || (err.code === 'RABBITMQ_AUTH_NOT_CONFIGURED' ? 503 : 502);
      res.status(status).json({
        success: false,
        error: { code: err.code || 'RABBITMQ_UNAVAILABLE', message: err.message },
      });
    }
  });

  app.get('/api/dashboard/rabbitmq/dlq/:queueName/messages', async (req, res) => {
    try {
      const meta = await rabbitmqMonitor.getDlqMetadata(req.params.queueName);
      res.json(meta);
    } catch (err) {
      const status = err.status || 502;
      res.status(status).json({
        success: false,
        error: { code: err.code || 'DLQ_INSPECTION_FAILED', message: err.message },
      });
    }
  });

  app.get('/api/dashboard/kong/rate-limit', async (req, res) => {
    try {
      const cfg = await readRateLimit(config.kongConfigPath);
      res.json(cfg);
    } catch (err) {
      res.status(503).json({
        verified: false,
        error: { code: 'KONG_CONFIG_UNAVAILABLE', message: err.message },
      });
    }
  });

  app.get('/api/dashboard/scenarios/orders/:orderId/trace', async (req, res) => {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId || orderId.length > 100) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ORDER_ID', message: 'Invalid orderId' },
      });
    }
    try {
      const trace = await stateReader.traceOrder(orderId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found in state/orders.json' },
        });
      }
      return res.json(trace);
    } catch {
      return res.status(500).json({
        success: false,
        error: { code: 'TRACE_READ_FAILED', message: 'Failed to read order trace state' },
      });
    }
  });

  app.post('/api/dashboard/scenarios/tms/stop', requireAuth, async (req, res) => {
    logger.warn('Audit: Requested stop mock-tms', { actor: req.auth?.iss || 'unknown' });
    try {
      const result = await dockerMonitor.controlMockTms('stop');
      eventHub.push({
        type: 'SERVICE_STATUS_CHANGED',
        service: 'mock-tms',
        status: 'WARNING',
        message: 'mock-tms stopped by authorized Dashboard user',
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({
        success: false,
        error: { code: 'TMS_STOP_FAILED', message: err.message },
      });
    }
  });

  app.post('/api/dashboard/scenarios/tms/start', requireAuth, async (req, res) => {
    logger.info('Audit: Requested start mock-tms', { actor: req.auth?.iss || 'unknown' });
    try {
      const result = await dockerMonitor.controlMockTms('start');
      eventHub.push({
        type: 'SERVICE_STATUS_CHANGED',
        service: 'mock-tms',
        status: 'SUCCESS',
        message: 'mock-tms started by authorized Dashboard user',
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({
        success: false,
        error: { code: 'TMS_START_FAILED', message: err.message },
      });
    }
  });

  app.get('/api/dashboard/events', async (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
    try {
      const historical = await stateReader.getHistoricalEvents(limit);
      const live = eventHub.list(limit);
      const mergedMap = new Map();
      for (const evt of [...live, ...historical]) {
        if (!mergedMap.has(evt.id)) mergedMap.set(evt.id, evt);
      }
      const events = Array.from(mergedMap.values())
        .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))
        .slice(0, limit);
      res.json({ events });
    } catch {
      res.json({ events: eventHub.list(limit) });
    }
  });

  app.get('/api/dashboard/events/stream', (req, res) => {
    eventHub.attachSseClient(req, res);
  });

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Dashboard API route not found' },
    });
  });

  return app;
}

module.exports = { createDashboardApp };
