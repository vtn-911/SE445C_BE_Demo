const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./app');
const path = require('node:path');
const { OrdersRepository } = require('./repositories/orders-repository');
const { OrderService } = require('./services/order-service');
const { OutboxPublisher } = require('./services/outbox-publisher');
const { RabbitMqRuntime } = require('./messaging/rabbitmq-runtime');
const { InventoryAdapter } = require('./integrations/wms/inventory-adapter');
const { InventoryService } = require('./services/inventory-service');
const { TmsShipmentAdapter } = require('./integrations/tms/shipment-adapter');

const ordersRepository = new OrdersRepository(path.resolve(config.stateDir));
const inventoryService = new InventoryService(new InventoryAdapter(config.wms));
const tmsAdapter = new TmsShipmentAdapter(config.tms);
const rabbitmq = new RabbitMqRuntime({
  ...config.rabbitmq,
  retryDelayMs: config.wmsRetryDelayMs,
  stateDir: path.resolve(config.stateDir),
  failSku: config.wms.failSku,
  tmsAdapter
});
const outboxPublisher = new OutboxPublisher({
  ordersRepository,
  publish: (event) => rabbitmq.publishOrderEvent(event)
});
rabbitmq.setOutboxPublisher(outboxPublisher);
rabbitmq.start();

const orderService = new OrderService({
  ordersRepository,
  inventoryService,
  notifyOutbox: () => {
    void outboxPublisher.flush().catch((error) => {
      logger.warn('Order saved in outbox; RabbitMQ publication is pending', {
        error: error.message
      });
    });
  }
});
const server = createApp({ inventoryService, orderService }).listen(config.port, () => {
  logger.info('ABC Retail Integration API started', {
    port: config.port,
    wmsMode: config.wms.mode
  });
});

function shutdown(signal) {
  logger.info('Shutting down HTTP server', { signal });
  void rabbitmq.stop();
  server.close((error) => {
    if (error) {
      logger.error('HTTP server shutdown failed', { error: error.message });
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
