const { consumers, deadLetterQueue, retryQueue } = require('../messaging/topology');

const ALLOWED_DLQS = new Set(consumers.map((c) => deadLetterQueue(c.queue)));

class RabbitMqMonitor {
  constructor({ baseUrl, user, pass, vhost = '%2F', timeoutMs = 5000, fetchFn = fetch, eventHub = null }) {
    this.baseUrl = baseUrl;
    this.user = user;
    this.pass = pass;
    this.vhost = vhost;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
    this.eventHub = eventHub;
    this.lastDlqCounts = new Map();
  }

  _headers() {
    const headers = { Accept: 'application/json' };
    if (this.user && this.pass) {
      const encoded = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    }
    return headers;
  }

  async _request(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this._headers(),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`RabbitMQ Management API returned HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async getQueuesSummary() {
    if (!this.user || !this.pass) {
      const err = new Error('RabbitMQ Management credentials are not configured');
      err.code = 'RABBITMQ_AUTH_NOT_CONFIGURED';
      throw err;
    }

    const allQueues = await this._request(`/api/queues/${this.vhost}`);
    const byName = new Map(allQueues.map((q) => [q.name, q]));

    const queues = [];
    for (const c of consumers) {
      const main = byName.get(c.queue);
      const dlqName = deadLetterQueue(c.queue);
      const dlq = byName.get(dlqName);
      const dlqCount = dlq?.messages_ready ?? dlq?.messages ?? 0;

      const prevDlq = this.lastDlqCounts.get(dlqName);
      if (typeof prevDlq === 'number' && dlqCount > prevDlq && this.eventHub) {
        this.eventHub.push({
          type: 'DLQ_MESSAGE_DETECTED',
          service: 'rabbitmq',
          status: 'ERROR',
          message: `DLQ ${dlqName} increased from ${prevDlq} to ${dlqCount}`,
        });
      }
      this.lastDlqCounts.set(dlqName, dlqCount);

      queues.push({
        name: c.queue,
        ready: main?.messages_ready ?? 0,
        unacked: main?.messages_unacknowledged ?? 0,
        consumers: main?.consumers ?? 0,
        dlqCount,
        dlqName,
      });

      if (c.retryExchange) {
        const rqName = retryQueue(c.queue);
        const rq = byName.get(rqName);
        queues.push({
          name: rqName,
          ready: rq?.messages_ready ?? 0,
          unacked: rq?.messages_unacknowledged ?? 0,
          consumers: rq?.consumers ?? 0,
          dlqCount: 0,
          dlqName,
        });
      }
    }

    return { queues };
  }

  async getDlqMetadata(queueName) {
    if (!ALLOWED_DLQS.has(queueName)) {
      const err = new Error(`Queue "${queueName}" is not an allowed DLQ`);
      err.code = 'INVALID_DLQ_NAME';
      err.status = 400;
      throw err;
    }

    if (!this.user || !this.pass) {
      const err = new Error('RabbitMQ Management credentials are not configured');
      err.code = 'RABBITMQ_AUTH_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }

    const q = await this._request(`/api/queues/${this.vhost}/${encodeURIComponent(queueName)}`);
    return {
      queueName,
      messageCount: q.messages ?? 0,
      messagesReady: q.messages_ready ?? 0,
      messagesUnacknowledged: q.messages_unacknowledged ?? 0,
      consumers: q.consumers ?? 0,
      state: q.state || 'unknown',
      payloadInspectionSupported: false,
      note: 'Read-only metadata only. Payload inspection is disabled to guarantee zero queue state mutation (no consume/get/ACK/purge).',
      messages: [],
    };
  }
}

module.exports = { RabbitMqMonitor, ALLOWED_DLQS };
