const express = require('express');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const { InventoryAdapter } = require('./integrations/wms/inventory-adapter');
const { InventoryService } = require('./services/inventory-service');
const { createInventoryRouter } = require('./routes/inventory-routes');
const { createOrderRouter } = require('./routes/order-routes');
const { errorHandler } = require('./errors');
const logger = require('./logger');
const openApi = require('../openapi/openapi.json');

function createApp({ inventoryService, orderService } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.log = logger;
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const adapter = new InventoryAdapter(config.wms);
  const service = inventoryService || new InventoryService(adapter);
  app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));
  app.use('/api/v1/inventory', createInventoryRouter(service));
  if (orderService) app.use('/api/v1/orders', createOrderRouter(orderService));
  app.use('/openapi.json', (req, res) => res.json(openApi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApi));
  app.use((req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
