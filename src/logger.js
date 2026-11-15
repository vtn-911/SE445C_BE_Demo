const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = process.env.LOG_LEVEL || 'info';
const threshold = levels[configuredLevel] === undefined ? levels.info : levels[configuredLevel];

function write(level, message, metadata = {}) {
  if (levels[level] > threshold) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...metadata
  };
  const output = level === 'error' ? console.error : console.log;
  output(JSON.stringify(record));
}

module.exports = {
  error: (message, metadata) => write('error', message, metadata),
  warn: (message, metadata) => write('warn', message, metadata),
  info: (message, metadata) => write('info', message, metadata),
  debug: (message, metadata) => write('debug', message, metadata)
};
