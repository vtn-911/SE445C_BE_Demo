const express = require('express');
const { createProductStockController } = require('../controllers/product-stock-controller');

function createProductStockRouter(inventoryService) {
  const router = express.Router();
  router.get('/:id/stock', createProductStockController(inventoryService).getById);
  return router;
}

module.exports = { createProductStockRouter };
