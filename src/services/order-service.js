const crypto = require('node:crypto');
const { HttpError } = require('../errors');

class OrderService {
  constructor({ ordersRepository, notifyOutbox }) {
    this.ordersRepository = ordersRepository;
    this.notifyOutbox = notifyOutbox;
  }

  async create(input) {
    if (
      !input ||
      typeof input.customerId !== 'string' ||
      !input.customerId.trim() ||
      !Array.isArray(input.items) ||
      input.items.length === 0 ||
      input.items.some((item) =>
        !item ||
        typeof item.sku !== 'string' ||
        !/^[A-Za-z0-9._-]{1,100}$/.test(item.sku) ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0
      )
    ) {
      throw new HttpError(400, 'INVALID_ORDER', 'customerId and at least one valid SKU/quantity item are required');
    }

    const order = {
      orderId: crypto.randomUUID(),
      customerId: input.customerId.trim(),
      items: input.items.map(({ sku, quantity }) => ({ sku, quantity })),
      status: 'accepted',
      createdAt: new Date().toISOString()
    };
    const event = {
      eventId: crypto.randomUUID(),
      eventType: 'order.created',
      occurredAt: order.createdAt,
      data: order
    };

    await this.ordersRepository.create(order, event);
    this.notifyOutbox();
    return { orderId: order.orderId, status: order.status };
  }
}

module.exports = { OrderService };
