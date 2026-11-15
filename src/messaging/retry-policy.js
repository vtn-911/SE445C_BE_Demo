const MAX_RETRIES = 3;

function nextFailureAction(retryCount) {
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new TypeError('retryCount must be a non-negative integer');
  }
  return retryCount < MAX_RETRIES ? 'retry' : 'dead-letter';
}

module.exports = { MAX_RETRIES, nextFailureAction };
