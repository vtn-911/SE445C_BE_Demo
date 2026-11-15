require('dotenv').config();

function positiveInteger(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || String(defaultValue), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const wmsMode = process.env.WMS_MODE || 'mock';
if (!['mock', 'http'].includes(wmsMode)) {
  throw new Error('WMS_MODE must be "mock" or "http"');
}

module.exports = {
  port: positiveInteger('PORT', 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  wms: {
    mode: wmsMode,
    baseUrl: process.env.WMS_BASE_URL || 'http://127.0.0.1:3100/api/v1',
    timeoutMs: positiveInteger('WMS_TIMEOUT_MS', 3000),
    failSku: process.env.WMS_FAIL_SKU || ''
  },
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
    reconnectMs: positiveInteger('RABBITMQ_RECONNECT_MS', 3000)
  },
  wmsRetryDelayMs: positiveInteger('WMS_RETRY_DELAY_MS', 5000),
  stateDir: process.env.STATE_DIR || 'state',
  batch: {
    inputFile: process.env.BATCH_INPUT_FILE || 'data/products.json',
    targetUrl: process.env.BATCH_TARGET_URL || '',
    timeoutMs: positiveInteger('BATCH_TIMEOUT_MS', 10000),
    cronTimezone: process.env.BATCH_CRON_TIMEZONE || 'Asia/Ho_Chi_Minh'
  }
};
