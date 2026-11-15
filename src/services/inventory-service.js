const { HttpError } = require('../errors');

class InventoryService {
  constructor(inventoryAdapter) {
    this.inventoryAdapter = inventoryAdapter;
  }

  async lookup(sku) {
    if (!sku || !/^[A-Za-z0-9._-]{1,100}$/.test(sku)) {
      throw new HttpError(400, 'INVALID_SKU', 'SKU must contain 1-100 letters, digits, dots, underscores or hyphens');
    }
    return this.inventoryAdapter.getInventory(sku);
  }
}

module.exports = { InventoryService };
