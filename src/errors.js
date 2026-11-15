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

  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const code = error.code || 'INTERNAL_ERROR';
  const message = statusCode >= 500 ? 'The request could not be completed' : error.message;

  req.log.error('Request failed', {
    method: req.method,
    path: req.originalUrl,
    code,
    statusCode,
    error: error.message
  });
  res.status(statusCode).json({ success: false, error: { code, message } });
}

module.exports = { HttpError, asyncHandler, errorHandler };
