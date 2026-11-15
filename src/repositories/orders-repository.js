const path = require('node:path');
const { JsonFileStore } = require('./json-file-store');

class OrdersRepository {
  constructor(stateDir) {
    this.store = new JsonFileStore(path.join(stateDir, 'orders.json'), { orders: [], outbox: [] });
  }

  async create(order, event) {
    await this.store.update((state) => {
      state.orders.push(order);
      state.outbox.push({ event, publishedAt: null });
    });
  }

  async listPendingEvents() {
    const state = await this.store.read();
    return state.outbox.filter((entry) => entry.publishedAt === null);
  }

  async markEventPublished(eventId) {
    await this.store.update((state) => {
      const entry = state.outbox.find((item) => item.event.eventId === eventId);
      if (entry) entry.publishedAt = new Date().toISOString();
    });
  }

  async listOrders() {
    return (await this.store.read()).orders;
  }
}

module.exports = { OrdersRepository };
