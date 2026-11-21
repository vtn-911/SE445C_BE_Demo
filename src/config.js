require('dotenv').config();

function positiveInteger(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || String(defaultValue), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function mockInventory(value) {
  const defaultValue = {
    SKU123: 50,
    'SKU-LOW-STOCK': 2,
    'SKU-OUT-OF-STOCK': 0
  };
  let inventory;

  try {
    inventory = value ? JSON.parse(value) : defaultValue;
  } catch (error) {
    throw new Error('WMS_MOCK_INVENTORY must be a JSON object');
  }

  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw new Error('WMS_MOCK_INVENTORY must be a JSON object');
  }
  for (const [sku, quantity] of Object.entries(inventory)) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(sku) || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error('WMS_MOCK_INVENTORY must map valid SKUs to non-negative integer quantities');
    }
  }
  return inventory;
}

const wmsMode = process.env.WMS_MODE || 'mock';
if (!['mock', 'http'].includes(wmsMode)) {
  throw new Error('WMS_MODE must be "mock" or "http"');
}
const wmsMockPort = positiveInteger('WMS_MOCK_PORT', 3100);

module.exports = {
  port: positiveInteger('PORT', 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  wms: {
    mode: wmsMode,
    baseUrl: process.env.WMS_BASE_URL || `http://127.0.0.1:${wmsMockPort}/api/v1/wms`,
    timeoutMs: positiveInteger('WMS_TIMEOUT_MS', 3000),
    failSku: process.env.WMS_FAIL_SKU || '',
    mockPort: wmsMockPort,
    mockInventory: mockInventory(process.env.WMS_MOCK_INVENTORY)
  },
  tms: {
    baseUrl: process.env.TMS_BASE_URL || 'http://127.0.0.1:3300/api/v1/tms',
    timeoutMs: positiveInteger('TMS_TIMEOUT_MS', 3000),
    mockPort: positiveInteger('TMS_MOCK_PORT', 3300)
  },
  crm: {
    mockPort: positiveInteger('CRM_MOCK_PORT', 3200)
  },
  batchReceiver: {
    mockPort: positiveInteger('BATCH_RECEIVER_PORT', 3500)
  },
  dataMapping: {
    serviceUrl: process.env.AI_MAPPING_SERVICE_URL || 'http://127.0.0.1:3400',
    timeoutMs: positiveInteger('AI_MAPPING_TIMEOUT_MS', 35000)
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
