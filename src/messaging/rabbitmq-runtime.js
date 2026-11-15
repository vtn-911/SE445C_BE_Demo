const amqp = require('amqplib');
const logger = require('../logger');
const {
  EXCHANGE,
  ORDER_CREATED,
  consumers,
  deadLetterQueue,
  retryQueue,
  assertTopology
} = require('./topology');
const { nextFailureAction } = require('./retry-policy');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class RabbitMqRuntime {
  constructor({ url, reconnectMs, retryDelayMs, stateDir, failSku }) {
    this.url = url;
    this.reconnectMs = reconnectMs;
    this.retryDelayMs = retryDelayMs;
    this.stateDir = stateDir;
    this.failSku = failSku;
    this.connection = null;
    this.confirmChannel = null;
    this.stopped = true;
    this.loop = null;
    this.outboxPublisher = null;
  }

  setOutboxPublisher(publisher) {
    this.outboxPublisher = publisher;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.connectLoop();
  }

  async connectLoop() {
    while (!this.stopped) {
      let connection;
      try {
        connection = await amqp.connect(this.url);
        this.connection = connection;
        connection.on('error', (error) => {
          logger.error('RabbitMQ connection error', { error: error.message });
        });

        let notifyClosed;
        const closed = new Promise((resolve) => {
          notifyClosed = resolve;
          connection.once('close', resolve);
        });
        await this.initializeConnection(connection);
        logger.info('RabbitMQ connected and consumers are ready');
        await this.flushOutbox();
        await closed;
      } catch (error) {
        logger.error('RabbitMQ connection or initialization failed', { error: error.message });
        if (connection) {
          try {
            await connection.close();
          } catch (closeError) {
            logger.warn('RabbitMQ connection close failed', { error: closeError.message });
          }
        }
      } finally {
        this.connection = null;
        this.confirmChannel = null;
      }

      if (!this.stopped) {
        logger.warn('RabbitMQ disconnected; reconnecting', { delayMs: this.reconnectMs });
        await delay(this.reconnectMs);
      }
    }
  }

  async initializeConnection(connection) {
    const topologyChannel = await connection.createChannel();
    await assertTopology(topologyChannel, this.retryDelayMs);
    await topologyChannel.close();

    this.confirmChannel = await connection.createConfirmChannel();
    const handlers = require('./order-consumers').createHandlers({
      stateDir: this.stateDir,
      failSku: this.failSku
    });

    for (const consumer of consumers) {
      const channel = await connection.createChannel();
      await channel.prefetch(1);
      channel.on('error', (error) => {
        logger.error('RabbitMQ consumer channel error', {
          consumer: consumer.name,
          error: error.message
        });
      });
      await channel.consume(consumer.queue, (message) => {
        if (!message) return;
        void this.processMessage(channel, consumer, handlers[consumer.queue], message);
      });
    }
  }

  async publishOrderEvent(event) {
    if (!this.confirmChannel) throw new Error('RabbitMQ publisher is not connected');
    const payload = Buffer.from(JSON.stringify(event));
    this.confirmChannel.publish(EXCHANGE, ORDER_CREATED, payload, {
      persistent: true,
      contentType: 'application/json',
      messageId: event.eventId,
      type: event.eventType,
      timestamp: Date.parse(event.occurredAt)
    });
    await this.confirmChannel.waitForConfirms();
  }

  async flushOutbox() {
    if (!this.outboxPublisher || !this.confirmChannel) return;
    try {
      await this.outboxPublisher.flush();
    } catch (error) {
      logger.warn('Order outbox remains pending; it will be retried after reconnect', {
        error: error.message
      });
    }
  }

  async processMessage(channel, consumer, handler, message) {
    let event;
    try {
      event = JSON.parse(message.content.toString('utf8'));
      if (event.eventType !== ORDER_CREATED || !event.eventId || !event.data) {
        throw new Error('Unsupported or malformed order event');
      }
      await handler(event);
      channel.ack(message);
      logger.info('Order message acknowledged', { consumer: consumer.name, eventId: event.eventId });
    } catch (error) {
      logger.error('Order message processing failed', {
        consumer: consumer.name,
        eventId: event && event.eventId,
        error: error.message
      });
      await this.routeFailedMessage(channel, consumer, message, error);
    }
  }

  async routeFailedMessage(channel, consumer, message, error) {
    const messageHeaders = message.properties.headers || {};
    const retryCount = Number(messageHeaders['x-retry-count'] || 0);
    const targetQueue = nextFailureAction(retryCount) === 'retry'
      ? retryQueue(consumer.queue)
      : deadLetterQueue(consumer.queue);
    const headers = {
      ...messageHeaders,
      'x-retry-count': retryCount + (targetQueue === retryQueue(consumer.queue) ? 1 : 0),
      'x-last-error': error.message.slice(0, 500)
    };

    try {
      if (!this.confirmChannel) throw new Error('RabbitMQ publisher is not connected');
      this.confirmChannel.sendToQueue(targetQueue, message.content, {
        persistent: true,
        contentType: message.properties.contentType || 'application/json',
        messageId: message.properties.messageId,
        type: message.properties.type,
        headers
      });
      await this.confirmChannel.waitForConfirms();
      channel.ack(message);
      logger.warn(targetQueue.endsWith('.dlq') ? 'Message sent to DLQ' : 'Message scheduled for retry', {
        consumer: consumer.name,
        eventId: message.properties.messageId,
        retryCount: headers['x-retry-count'],
        targetQueue
      });
    } catch (publishError) {
      logger.error('Could not route failed message; requeueing original', {
        consumer: consumer.name,
        error: publishError.message
      });
      try {
        channel.nack(message, false, true);
      } catch (ackError) {
        logger.error('Could not requeue failed message', { error: ackError.message });
      }
    }
  }

  async stop() {
    this.stopped = true;
    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        logger.warn('RabbitMQ shutdown failed', { error: error.message });
      }
    }
    if (this.loop) await this.loop;
  }
}

module.exports = { RabbitMqRuntime };
