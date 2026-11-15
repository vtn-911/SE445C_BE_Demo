const express = require('express');
const { createOrderController } = require('../controllers/order-controller');

function createOrderRouter(orderService) {
  const router = express.Router();
  router.post('/', createOrderController(orderService).create);
  return router;
}

module.exports = { createOrderRouter };
