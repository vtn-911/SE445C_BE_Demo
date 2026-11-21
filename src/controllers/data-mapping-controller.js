const { asyncHandler } = require('../errors');

function createDataMappingController(dataMappingService) {
  return {
    mapProduct: asyncHandler(async (req, res) => {
      const result = await dataMappingService.mapProduct(req.body);
      res.status(result.statusCode).json(result.body);
    })
  };
}

module.exports = { createDataMappingController };
