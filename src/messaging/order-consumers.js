const logger = require('../logger');
const { ConsumerEventsRepository } = require('../repositories/consumer-events-repository');
const { consumers } = require('./topology');

function createHandlers({ stateDir, failSku, tmsAdapter }) {
  const handlers = {};

  for (const consumer of consumers) {
    const events = new ConsumerEventsRepository(stateDir, consumer.name);
    handlers[consumer.queue] = async (event) => {
      const processed = await events.processOnce(event.eventId, async () => {
        if (consumer.name === 'wms' && failSku && event.data.items.some((item) => item.sku === failSku)) {
          throw new Error(`Simulated WMS reservation failure for ${failSku}`);
        }
        if (consumer.name === 'tms') {
          if (!tmsAdapter) throw new Error('TMS shipment adapter is not configured');
          const shipment = await tmsAdapter.createShipment(event);
          logger.info('TMS shipment processed', {
            eventId: event.eventId,
            orderId: event.data.orderId,
            shipmentId: shipment.shipmentId
          });
          return;
        }
        logger.info(`${consumer.name} processed order event`, {
          consumer: consumer.name,
          eventId: event.eventId,
          orderId: event.data.orderId
        });
      });

      if (!processed) {
        logger.info('Duplicate order event ignored', {
          consumer: consumer.name,
          eventId: event.eventId
        });
      }
    };
  }

  return handlers;
}

module.exports = { createHandlers };
