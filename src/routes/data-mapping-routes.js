const express = require('express');
const { createDataMappingController } = require('../controllers/data-mapping-controller');

function createDataMappingRouter(dataMappingService) {
  const router = express.Router();
  router.post('/products', createDataMappingController(dataMappingService).mapProduct);
  return router;
}

module.exports = { createDataMappingRouter };
