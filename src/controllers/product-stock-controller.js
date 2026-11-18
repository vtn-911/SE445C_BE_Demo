const { HttpError, asyncHandler } = require('../errors');
const products = require('../../data/products.json');

function createProductStockController(inventoryService) {
  return {
    getById: asyncHandler(async (req, res) => {
      const product = products.find((item) => item.sku === req.params.id);
      if (!product) {
        throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product was not found');
      }

      const inventory = await inventoryService.lookup(product.sku);
      res.json({
        success: true,
        data: {
          productId: product.sku,
          sku: product.sku,
          availableQuantity: inventory.availableQuantity
        }
      });
    })
  };
}

module.exports = { createProductStockController };
