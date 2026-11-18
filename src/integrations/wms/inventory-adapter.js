class WmsIntegrationError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'WmsIntegrationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const defaultMockInventory = Object.freeze({
  SKU123: 50,
  'SKU-LOW-STOCK': 2,
  'SKU-OUT-OF-STOCK': 0
});

class InventoryAdapter {
  constructor({ mode, baseUrl, timeoutMs, mockInventory = defaultMockInventory, fetchImpl = fetch }) {
    this.mode = mode;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.mockInventory = mockInventory;
    this.fetchImpl = fetchImpl;
  }

  async getInventory(sku) {
    if (this.mode === 'mock') {
      if (!Object.prototype.hasOwnProperty.call(this.mockInventory, sku)) {
        throw new WmsIntegrationError(404, 'SKU_NOT_FOUND', `SKU ${sku} was not found`);
      }
      const availableQuantity = this.mockInventory[sku];
      return { sku, availableQuantity };
    }

    return this.fetchInventory(sku);
  }

  async fetchInventory(sku) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const base = this.baseUrl.replace(/\/+$/, '');
      const response = await this.fetchImpl(
        `${base}/inventory/${encodeURIComponent(sku)}`,
        { signal: controller.signal }
      );
      if (response.status === 404) {
        throw new WmsIntegrationError(404, 'SKU_NOT_FOUND', `SKU ${sku} was not found`);
      }
      if (!response.ok) {
        throw new WmsIntegrationError(503, 'WMS_UNAVAILABLE', `WMS returned HTTP ${response.status}`);
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new WmsIntegrationError(502, 'WMS_INVALID_RESPONSE', 'WMS returned invalid JSON');
      }

      if (
        !payload ||
        payload.sku !== sku ||
        !Number.isInteger(payload.availableQuantity) ||
        payload.availableQuantity < 0
      ) {
        throw new WmsIntegrationError(502, 'WMS_INVALID_RESPONSE', 'WMS returned invalid inventory data');
      }
      return { sku, availableQuantity: payload.availableQuantity };
    } catch (error) {
      if (error instanceof WmsIntegrationError) throw error;
      if (controller.signal.aborted) {
        throw new WmsIntegrationError(504, 'WMS_TIMEOUT', 'WMS did not respond before the timeout');
      }
      throw new WmsIntegrationError(503, 'WMS_UNAVAILABLE', 'WMS could not be reached');
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { InventoryAdapter, WmsIntegrationError };
