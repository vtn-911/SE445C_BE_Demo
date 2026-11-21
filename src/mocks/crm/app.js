const express = require('express');
const { HttpError, asyncHandler, errorHandler } = require('../../errors');
const logger = require('../../logger');

function isValidCustomerId(customerId) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(customerId);
}

function isValidPointsRequest(body) {
  return Boolean(
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    Object.hasOwn(body, 'points') &&
    Number.isSafeInteger(body.points) &&
    body.points >= 0
  );
}

function createMockCrmApp({ customersRepository }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.log = logger;
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));
  app.put('/api/v1/crm/customers/:id/points', asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidCustomerId(id)) {
      throw new HttpError(400, 'INVALID_CUSTOMER_ID', 'Customer ID is invalid');
    }
    if (!isValidPointsRequest(req.body)) {
      throw new HttpError(400, 'INVALID_POINTS', 'points must be a non-negative safe integer');
    }

    const customer = await customersRepository.setPoints(id, req.body.points);
    if (!customer) {
      throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer was not found');
    }

    logger.info('Mock CRM customer points updated', {
      customerId: customer.customerId,
      points: customer.points
    });
    res.json({ success: true, data: customer });
  }));
  app.use(errorHandler);
  return app;
}

module.exports = { createMockCrmApp };
