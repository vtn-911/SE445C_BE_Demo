const path = require('node:path');
const { JsonFileStore } = require('./json-file-store');

class ShipmentsRepository {
  constructor(stateDir) {
    this.store = new JsonFileStore(path.join(stateDir, 'shipments.json'), { shipments: [] });
  }

  async createIfAbsent(shipment) {
    let result;
    await this.store.update((state) => {
      const existing = state.shipments.find((item) => item.eventId === shipment.eventId);
      if (existing) {
        result = { shipment: existing, created: false };
        return;
      }

      state.shipments.push(shipment);
      result = { shipment, created: true };
    });
    return result;
  }

  async list() {
    return (await this.store.read()).shipments;
  }
}

module.exports = { ShipmentsRepository };
