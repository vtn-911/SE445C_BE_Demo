const { asyncHandler } = require('../errors');

function createOrderController(orderService) {
  return {
    create: asyncHandler(async (req, res) => {
      const result = await orderService.create(req.body);
      res.status(202).json({ success: true, data: result });
    })
  };
}

module.exports = { createOrderController };
