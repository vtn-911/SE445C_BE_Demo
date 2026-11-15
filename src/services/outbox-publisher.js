const logger = require('../logger');

class OutboxPublisher {
  constructor({ ordersRepository, publish }) {
    this.ordersRepository = ordersRepository;
    this.publish = publish;
    this.running = null;
  }

  flush() {
    if (this.running) return this.running;
    this.running = this.flushPending().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async flushPending() {
    const pending = await this.ordersRepository.listPendingEvents();
    for (const { event } of pending) {
      await this.publish(event);
      await this.ordersRepository.markEventPublished(event.eventId);
      logger.info('Order event published', { eventId: event.eventId, eventType: event.eventType });
    }
  }
}

module.exports = { OutboxPublisher };
