const express = require('express');
const swaggerUi = require('swagger-ui-express');
const { createInventoryRouter } = require('./routes/inventory-routes');
const { createProductStockRouter } = require('./routes/product-stock-routes');
const { createOrderRouter } = require('./routes/order-routes');
const { createDataMappingRouter } = require('./routes/data-mapping-routes');
const { errorHandler } = require('./errors');
const logger = require('./logger');
const openApi = require('../openapi/openapi.json');
const publicOpenApi = {
  ...openApi,
  paths: Object.fromEntries(
    Object.entries(openApi.paths).filter(([path]) =>
      path !== '/health' &&
      !path.startsWith('/api/v1/wms/') &&
      !path.startsWith('/api/v1/tms/') &&
      !path.startsWith('/api/v1/mapping/')
    )
  )
};

function createApp({ inventoryService, orderService, dataMappingService } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.log = logger;
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  if (!inventoryService) {
    const config = require('./config');
    const { InventoryAdapter } = require('./integrations/wms/inventory-adapter');
    const { InventoryService } = require('./services/inventory-service');
    inventoryService = new InventoryService(new InventoryAdapter(config.wms));
  }
  app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));
  app.use('/api/v1/inventory', createInventoryRouter(inventoryService));
  app.use('/api/v1/products', createProductStockRouter(inventoryService));
  if (dataMappingService) {
    app.use('/api/v1/data-mapping', createDataMappingRouter(dataMappingService));
  }
  if (orderService) app.use('/api/v1/orders', createOrderRouter(orderService));
  app.use('/openapi.json', (req, res) => res.json(publicOpenApi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(publicOpenApi));
  app.use((req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
