const EXCHANGE = 'abc.events';
const DEAD_LETTER_EXCHANGE = 'abc.dead-letter';
const WMS_RETRY_EXCHANGE = 'abc.wms.retry';
const TMS_RETRY_EXCHANGE = 'abc.tms.retry';
const ORDER_CREATED = 'order.created';

const consumers = [
  { name: 'payment', queue: 'payment.order-created', routingKey: ORDER_CREATED },
  { name: 'wms', queue: 'wms.order-created', routingKey: ORDER_CREATED, retryExchange: WMS_RETRY_EXCHANGE },
  { name: 'notification', queue: 'notification.order-created', routingKey: ORDER_CREATED },
  { name: 'tms', queue: 'tms.order-created', routingKey: ORDER_CREATED, retryExchange: TMS_RETRY_EXCHANGE }
];

function deadLetterQueue(queue) {
  return `${queue}.dlq`;
}

function retryQueue(queue) {
  return `${queue}.retry`;
}

async function assertTopology(channel, retryDelayMs) {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(WMS_RETRY_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(TMS_RETRY_EXCHANGE, 'direct', { durable: true });

  for (const consumer of consumers) {
    await channel.assertQueue(deadLetterQueue(consumer.queue), { durable: true });
    await channel.bindQueue(
      deadLetterQueue(consumer.queue),
      DEAD_LETTER_EXCHANGE,
      deadLetterQueue(consumer.queue)
    );

    await channel.assertQueue(consumer.queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
        'x-dead-letter-routing-key': deadLetterQueue(consumer.queue)
      }
    });
    await channel.bindQueue(consumer.queue, EXCHANGE, consumer.routingKey);
  }

  for (const consumer of consumers.filter((item) => item.retryExchange)) {
    await channel.assertQueue(retryQueue(consumer.queue), {
      durable: true,
      arguments: {
        'x-message-ttl': retryDelayMs,
        'x-dead-letter-exchange': consumer.retryExchange,
        'x-dead-letter-routing-key': consumer.queue
      }
    });
    await channel.bindQueue(consumer.queue, consumer.retryExchange, consumer.queue);
  }
}

module.exports = {
  EXCHANGE,
  ORDER_CREATED,
  WMS_RETRY_EXCHANGE,
  TMS_RETRY_EXCHANGE,
  consumers,
  deadLetterQueue,
  retryQueue,
  assertTopology
};
