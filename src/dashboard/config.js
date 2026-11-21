const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../runtime/.env.dashboard') });

const projectRoot = path.resolve(__dirname, '../..');

function parseRabbitMqMgmtFromUrl(amqpUrl) {
  if (!amqpUrl) return null;
  try {
    const parsed = new URL(amqpUrl);
    return {
      user: decodeURIComponent(parsed.username || ''),
      pass: decodeURIComponent(parsed.password || ''),
      host: parsed.hostname || 'localhost',
    };
  } catch {
    return null;
  }
}

const parsedAmqp = parseRabbitMqMgmtFromUrl(process.env.RABBITMQ_URL);

module.exports = {
  port: Number(process.env.DASHBOARD_PORT || 4000),
  corsOrigin: process.env.DASHBOARD_CORS_ORIGIN || 'http://localhost:5173',
  projectRoot,
  composeFile: path.resolve(projectRoot, process.env.COMPOSE_FILE || 'docker-compose.yml'),
  stateDir: path.resolve(projectRoot, process.env.STATE_DIR || 'state'),
  kongConfigPath: path.resolve(projectRoot, process.env.KONG_CONFIG_PATH || 'kong/kong.yml'),
  healthCacheTtlMs: Number(process.env.DASHBOARD_HEALTH_CACHE_MS || 3000),
  dockerTimeoutMs: Number(process.env.DASHBOARD_DOCKER_TIMEOUT_MS || 15000),
  rateLimitWindowMs: 60000,
  rateLimitMax: Number(process.env.DASHBOARD_RATE_LIMIT_MAX || 180),
  jwt: {
    secret: process.env.DASHBOARD_JWT_SECRET || '',
    issuer: process.env.DASHBOARD_JWT_ISS || 'abc-retail-demo',
  },
  rabbitmqMgmt: {
    baseUrl: (process.env.RABBITMQ_MGMT_URL || 'http://127.0.0.1:15672').replace(/\/+$/, ''),
    user: process.env.RABBITMQ_MGMT_USER || parsedAmqp?.user || '',
    pass: process.env.RABBITMQ_MGMT_PASS || parsedAmqp?.pass || '',
    vhost: process.env.RABBITMQ_VHOST || '%2F',
    timeoutMs: Number(process.env.RABBITMQ_MGMT_TIMEOUT_MS || 5000),
  },
};
