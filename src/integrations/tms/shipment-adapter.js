class TmsIntegrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TmsIntegrationError';
  }
}

class TmsShipmentAdapter {
  constructor({ baseUrl, timeoutMs, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async createShipment(event) {
    const order = event.data;
    const payload = {
      eventId: event.eventId,
      orderId: order.orderId,
      customerId: order.customerId,
      items: order.items
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/shipments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': event.eventId
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new TmsIntegrationError(`TMS returned HTTP ${response.status}`);
      }

      let result;
      try {
        result = await response.json();
      } catch (error) {
        throw new TmsIntegrationError('TMS returned invalid JSON');
      }
      if (
        !result ||
        result.success !== true ||
        !result.data ||
        !result.data.shipment ||
        result.data.shipment.eventId !== event.eventId
      ) {
        throw new TmsIntegrationError('TMS returned an invalid shipment response');
      }
      return result.data.shipment;
    } catch (error) {
      if (error instanceof TmsIntegrationError) throw error;
      if (controller.signal.aborted) {
        throw new TmsIntegrationError(`TMS request timed out after ${this.timeoutMs}ms`);
      }
      throw new TmsIntegrationError(`TMS could not be reached: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { TmsShipmentAdapter, TmsIntegrationError };
