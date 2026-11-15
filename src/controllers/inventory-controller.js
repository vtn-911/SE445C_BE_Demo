const { asyncHandler } = require('../errors');

function createInventoryController(inventoryService) {
  return {
    getBySku: asyncHandler(async (req, res) => {
      const inventory = await inventoryService.lookup(req.params.sku);
      res.json({ success: true, data: inventory });
    })
  };
}

module.exports = { createInventoryController };
