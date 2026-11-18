const express = require('express');
const logger = require('../../logger');

function createWmsMockApp({ inventory }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));
  app.get('/api/v1/wms/inventory/:sku', (req, res) => {
    const { sku } = req.params;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(sku)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_SKU', message: 'SKU is invalid' }
      });
    }
    if (!Object.prototype.hasOwnProperty.call(inventory, sku)) {
      return res.status(404).json({
        success: false,
        error: { code: 'SKU_NOT_FOUND', message: 'SKU was not found' }
      });
    }

    const result = { sku, availableQuantity: inventory[sku] };
    logger.info('Mock WMS inventory returned', result);
    return res.json(result);
  });
  return app;
}

module.exports = { createWmsMockApp };
