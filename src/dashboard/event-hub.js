const crypto = require('node:crypto');

class EventHub {
  constructor(maxEvents = 200) {
    this.maxEvents = maxEvents;
    this.events = [];
    this.clients = new Set();
  }

  push(event) {
    const normalized = {
      id: event.id || crypto.randomUUID(),
      timestamp: event.timestamp || new Date().toISOString(),
      type: event.type || 'SYSTEM_EVENT',
      service: event.service || 'dashboard-backend',
      status: event.status || 'INFO',
      message: event.message || '',
    };

    if (this.events.some((e) => e.id === normalized.id)) {
      return normalized;
    }

    this.events.unshift(normalized);
    if (this.events.length > this.maxEvents) {
      this.events.length = this.maxEvents;
    }

    const payload = `data: ${JSON.stringify(normalized)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
    return normalized;
  }

  list(limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, this.maxEvents));
    return this.events.slice(0, safeLimit);
  }

  attachSseClient(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write('retry: 3000\n\n');
    for (const evt of this.events.slice(0, 25).reverse()) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }

    this.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        this.clients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
  }
}

module.exports = { EventHub };
