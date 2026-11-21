const { HttpError } = require('../../errors');

const TARGET_FIELDS = new Set(['sku', 'name', 'category', 'price']);
const PYTHON_STATUSES = new Set([200, 400, 413, 422, 503, 504]);

function isValidMappingRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'format') || !Object.hasOwn(input, 'payload')) {
    return false;
  }
  if (input.format === 'json') {
    return Boolean(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload));
  }
  return input.format === 'xml' &&
    typeof input.payload === 'string' &&
    input.payload.trim().length > 0;
}

function isStringRecord(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) =>
      TARGET_FIELDS.has(key) && typeof item === 'string' && item.length > 0
    )
  );
}

function isSuccessResponse(body) {
  const data = body && body.data;
  const mappedFields = body && body.mapping && Object.keys(body.mapping).sort().join(',');
  return Boolean(
    body &&
    body.status === 'success' &&
    body.canonicalVersion === 'Product-v1' &&
    data &&
    typeof data.sku === 'string' &&
    data.sku.trim() &&
    /^[A-Za-z0-9._-]{1,100}$/.test(data.sku) &&
    typeof data.name === 'string' &&
    data.name.trim() &&
    typeof data.category === 'string' &&
    data.category.trim() &&
    typeof data.price === 'number' &&
    Number.isFinite(data.price) &&
    data.price >= 0 &&
    isStringRecord(body.mapping) &&
    mappedFields === 'category,name,price,sku' &&
    body.confidence === 'high' &&
    Array.isArray(body.warnings)
  );
}

function isNeedsReviewResponse(body) {
  return Boolean(
    body &&
    body.status === 'needsReview' &&
    body.canonicalVersion === 'Product-v1' &&
    isStringRecord(body.mapping) &&
    ['high', 'medium', 'low'].includes(body.confidence) &&
    Array.isArray(body.unmappedFields) &&
    body.unmappedFields.every((field) => TARGET_FIELDS.has(field)) &&
    Array.isArray(body.warnings) &&
    body.warnings.every((warning) => typeof warning === 'string')
  );
}

function isErrorResponse(body) {
  return Boolean(
    body &&
    body.status === 'error' &&
    body.error &&
    typeof body.error.code === 'string' &&
    typeof body.error.message === 'string'
  );
}

class DataMappingAdapter {
  constructor({ serviceUrl, timeoutMs, fetchImpl = fetch }) {
    this.serviceUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async mapProduct(input) {
    if (!isValidMappingRequest(input)) {
      throw new HttpError(
        400,
        'INVALID_MAPPING_REQUEST',
        'format and a matching JSON object or XML string payload are required'
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.serviceUrl}/api/v1/mapping/products`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: controller.signal
      });

      let body;
      try {
        body = await response.json();
      } catch {
        throw new HttpError(502, 'MAPPING_SERVICE_INVALID_RESPONSE', 'Mapping service returned invalid JSON');
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(502, 'MAPPING_SERVICE_INVALID_RESPONSE', 'Mapping service returned an invalid response');
      }
      if (!PYTHON_STATUSES.has(response.status)) {
        throw new HttpError(502, 'MAPPING_SERVICE_ERROR', 'Mapping service returned an unexpected status');
      }
      if (response.status === 200 && !isSuccessResponse(body)) {
        throw new HttpError(502, 'MAPPING_SERVICE_INVALID_RESPONSE', 'Mapping service returned an invalid success response');
      }
      if (response.status === 422 && !isNeedsReviewResponse(body)) {
        throw new HttpError(502, 'MAPPING_SERVICE_INVALID_RESPONSE', 'Mapping service returned an invalid review response');
      }
      if (response.status !== 200 && response.status !== 422 && !isErrorResponse(body)) {
        throw new HttpError(502, 'MAPPING_SERVICE_INVALID_RESPONSE', 'Mapping service returned an invalid error response');
      }

      return { statusCode: response.status, body };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted || error.name === 'AbortError') {
        throw new HttpError(504, 'MAPPING_SERVICE_TIMEOUT', 'Mapping service did not respond before the timeout');
      }
      throw new HttpError(503, 'MAPPING_SERVICE_UNAVAILABLE', 'Mapping service could not be reached');
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  DataMappingAdapter,
  isNeedsReviewResponse,
  isSuccessResponse,
  isValidMappingRequest
};
