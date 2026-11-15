const express = require('express');
const { createInventoryController } = require('../controllers/inventory-controller');

function createInventoryRouter(inventoryService) {
  const router = express.Router();
  const controller = createInventoryController(inventoryService);
  router.get('/:sku', controller.getBySku);
  return router;
}

module.exports = { createInventoryRouter };
