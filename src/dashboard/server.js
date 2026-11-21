const config = require('./config');
const logger = require('../logger');
const { EventHub } = require('./event-hub');
const { DockerMonitor } = require('./docker-monitor');
const { RabbitMqMonitor } = require('./rabbitmq-monitor');
const { StateReader } = require('./state-reader');
const { createDashboardApp } = require('./app');

const eventHub = new EventHub(200);
const dockerMonitor = new DockerMonitor({
  composeFile: config.composeFile,
  cacheTtlMs: config.healthCacheTtlMs,
  timeoutMs: config.dockerTimeoutMs,
  eventHub,
});
const rabbitmqMonitor = new RabbitMqMonitor({
  ...config.rabbitmqMgmt,
  eventHub,
});
const stateReader = new StateReader(config.stateDir);

// Seed recent verifiable historical events from state files on startup
stateReader
  .getHistoricalEvents(50)
  .then((events) => {
    for (const evt of events.reverse()) {
      eventHub.push(evt);
    }
  })
  .catch((err) => {
    logger.warn('Could not seed historical events from stateDir', { error: err.message });
  });

const app = createDashboardApp({
  config,
  dockerMonitor,
  rabbitmqMonitor,
  stateReader,
  eventHub,
});

const server = app.listen(config.port, () => {
  logger.info('ABC Retail Dashboard Backend started', {
    port: config.port,
    corsOrigin: config.corsOrigin,
  });
});

function shutdown(signal) {
  logger.info('Shutting down Dashboard Backend', { signal });
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
