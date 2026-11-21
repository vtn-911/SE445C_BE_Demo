class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const bodyParserError = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
  const candidateStatus = Number.isInteger(error.statusCode)
    ? error.statusCode
    : bodyParserError
      ? error.status
      : undefined;
  const statusCode = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : 500;
  const code = error.type === 'entity.parse.failed'
    ? 'INVALID_JSON'
    : error.type === 'entity.too.large'
      ? 'PAYLOAD_TOO_LARGE'
      : error.code || 'INTERNAL_ERROR';
  const message = bodyParserError
    ? statusCode === 413 ? 'Request body exceeds the size limit' : 'Request body must be valid JSON'
    : statusCode >= 500 ? 'The request could not be completed' : error.message;

  req.log.error('Request failed', {
    method: req.method,
    path: req.originalUrl,
    code,
    statusCode,
    error: bodyParserError ? code : error.message
  });
  res.status(statusCode).json({ success: false, error: { code, message } });
}

module.exports = { HttpError, asyncHandler, errorHandler };
