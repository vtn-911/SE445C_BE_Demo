async function sendBatch({ targetUrl, batchNumber, runId, products, timeoutMs, fetchImpl = fetch }) {
  if (!targetUrl) throw new Error('BATCH_TARGET_URL is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, batchNumber, products }),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Batch ${batchNumber} request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw new Error(`Batch ${batchNumber} request failed: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Batch ${batchNumber} target returned HTTP ${response.status}`);
  }
}

module.exports = { sendBatch };
