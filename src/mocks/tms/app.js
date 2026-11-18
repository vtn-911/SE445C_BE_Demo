const express = require('express');
const crypto = require('node:crypto');
const { HttpError, asyncHandler, errorHandler } = require('../../errors');
const logger = require('../../logger');

function isValidShipmentRequest(input) {
  return Boolean(
    input &&
    typeof input.eventId === 'string' &&
    input.eventId.trim() &&
    typeof input.orderId === 'string' &&
    input.orderId.trim() &&
    typeof input.customerId === 'string' &&
    input.customerId.trim() &&
    Array.isArray(input.items) &&
    input.items.length > 0 &&
    input.items.every((item) =>
      item &&
      typeof item.sku === 'string' &&
      /^[A-Za-z0-9._-]{1,100}$/.test(item.sku) &&
      Number.isSafeInteger(item.quantity) &&
      item.quantity > 0
    )
  );
}

function sameShipmentRequest(shipment, input) {
  return shipment.orderId === input.orderId &&
    shipment.customerId === input.customerId &&
    JSON.stringify(shipment.items) === JSON.stringify(input.items);
}

function createTmsMockApp({ shipmentsRepository }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    req.log = logger;
    next();
  });
  app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));
  app.post('/api/v1/tms/shipments', asyncHandler(async (req, res) => {
    const input = req.body;
    if (!isValidShipmentRequest(input)) {
      throw new HttpError(
        400,
        'INVALID_SHIPMENT',
        'eventId, orderId, customerId and valid shipment items are required'
      );
    }

    const shipment = {
      shipmentId: crypto.randomUUID(),
      eventId: input.eventId.trim(),
      orderId: input.orderId.trim(),
      customerId: input.customerId.trim(),
      items: input.items.map(({ sku, quantity }) => ({ sku, quantity })),
      status: 'created',
      createdAt: new Date().toISOString()
    };
    const result = await shipmentsRepository.createIfAbsent(shipment);
    if (!sameShipmentRequest(result.shipment, input)) {
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'eventId was already used for a different shipment');
    }

    if (result.created) {
      logger.info('Mock TMS shipment created', result.shipment);
    } else {
      logger.info('Mock TMS duplicate shipment request', {
        eventId: result.shipment.eventId,
        orderId: result.shipment.orderId
      });
    }
    res.status(result.created ? 201 : 200).json({
      success: true,
      data: { shipment: result.shipment, duplicate: !result.created }
    });
  }));
  app.use(errorHandler);
  return app;
}

module.exports = { createTmsMockApp };
