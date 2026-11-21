const fs = require('node:fs/promises');
const path = require('node:path');

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

class StateReader {
  constructor(stateDir) {
    this.stateDir = stateDir;
  }

  async getOrdersState() {
    return readJsonSafe(path.join(this.stateDir, 'orders.json'), { orders: [], outbox: [] });
  }

  async getShipmentsState() {
    return readJsonSafe(path.join(this.stateDir, 'tms', 'shipments.json'), { shipments: [] });
  }

  async getOrderMetrics(nowMs = Date.now()) {
    const { orders } = await this.getOrdersState();
    const oneMinAgo = nowMs - 60_000;
    let throughputPerMin = 0;

    // Bucket last 10 minutes
    const buckets = new Map();
    for (let i = 9; i >= 0; i -= 1) {
      const bucketTime = new Date(nowMs - i * 60_000);
      const label = bucketTime.toISOString().slice(11, 16);
      buckets.set(label, 0);
    }

    for (const order of orders) {
      const ts = Date.parse(order.createdAt);
      if (Number.isNaN(ts)) continue;
      if (ts >= oneMinAgo && ts <= nowMs) {
        throughputPerMin += 1;
      }
      if (ts >= nowMs - 10 * 60_000 && ts <= nowMs) {
        const label = new Date(ts).toISOString().slice(11, 16);
        if (buckets.has(label)) {
          buckets.set(label, buckets.get(label) + 1);
        }
      }
    }

    const throughputSeries = Array.from(buckets.entries()).map(([label, value]) => ({ label, value }));
    return {
      totalOrders: orders.length,
      throughputPerMin,
      throughputSeries,
    };
  }

  async getConsumerState(consumerName) {
    return readJsonSafe(path.join(this.stateDir, 'consumers', `${consumerName}.json`), {
      processedEventIds: [],
    });
  }

  // Real outbox entries (see OrdersRepository.create / OrderService.create) store the
  // order under `event.data`. `event.payload` is kept only as a legacy fallback.
  static orderIdOfEvent(event) {
    return event?.data?.orderId ?? event?.payload?.orderId ?? null;
  }

  async traceOrder(orderId, nowMs = Date.now(), { tmsStaleAfterMs = 60_000 } = {}) {
    const [{ orders, outbox }, { shipments }, tmsConsumer] = await Promise.all([
      this.getOrdersState(),
      this.getShipmentsState(),
      this.getConsumerState('tms'),
    ]);

    const order = orders.find((o) => o.orderId === orderId);
    if (!order) return null;

    // Order -> Event: strictly through the outbox entry of this order.
    const outboxEntry = outbox.find((entry) => StateReader.orderIdOfEvent(entry?.event) === orderId);
    const eventId = outboxEntry?.event?.eventId || null;
    // Event -> Shipment: by eventId first; orderId must match exactly as fallback.
    const shipment =
      (eventId && shipments.find((s) => s.eventId === eventId)) ||
      shipments.find((s) => s.orderId === orderId) ||
      null;
    const shipmentId = shipment?.shipmentId || null;
    const tmsConsumed = Boolean(eventId && tmsConsumer.processedEventIds?.includes(eventId));

    const wmsChecked = order.status === 'accepted' ? 'SUCCESS' : 'UNKNOWN';
    const eventPublished = outboxEntry
      ? outboxEntry.publishedAt
        ? 'SUCCESS'
        : 'PENDING'
      : 'UNKNOWN';

    let tmsCreated;
    let tmsDetail;
    if (shipment) {
      if (shipment.status && shipment.status !== 'created') {
        tmsCreated = 'FAILED';
        tmsDetail = `Shipment ${shipmentId} has status "${shipment.status}"`;
      } else {
        tmsCreated = 'SUCCESS';
        tmsDetail = `Shipment ${shipmentId} created at ${shipment.createdAt}${
          tmsConsumed ? ' (TMS consumer processed event)' : ''
        }`;
      }
    } else if (tmsConsumed) {
      tmsCreated = 'UNKNOWN';
      tmsDetail = 'TMS consumer recorded the event but no matching shipment was found in state/tms/shipments.json';
    } else if (eventPublished === 'SUCCESS') {
      const publishedMs = Date.parse(outboxEntry.publishedAt);
      const stale = Number.isFinite(publishedMs) && nowMs - publishedMs > tmsStaleAfterMs;
      if (stale) {
        tmsCreated = 'UNKNOWN';
        tmsDetail =
          `No shipment ${Math.round((nowMs - publishedMs) / 1000)}s after publish. ` +
          'Per-order failure evidence is not persisted; the message may be in TMS Retry/DLQ (see RabbitMQ & DLQ page)';
      } else {
        tmsCreated = 'PENDING';
        tmsDetail = 'Awaiting TMS shipment creation (consumer has not recorded this event yet)';
      }
    } else if (eventPublished === 'PENDING') {
      tmsCreated = 'PENDING';
      tmsDetail = 'Order event not yet published, so TMS has not received it';
    } else {
      tmsCreated = 'UNKNOWN';
      tmsDetail = 'No outbox entry found for this order, cannot verify TMS processing';
    }

    return {
      orderId,
      eventId,
      shipmentId,
      steps: {
        wmsChecked,
        eventPublished,
        tmsCreated,
        wmsDetail:
          wmsChecked === 'SUCCESS'
            ? 'Order persisted with status "accepted" (stock check runs before the order is stored)'
            : `Order status is "${order.status}", WMS check not verified`,
        eventDetail: outboxEntry?.publishedAt
          ? `Published at ${outboxEntry.publishedAt} (eventId: ${eventId})`
          : outboxEntry
            ? `Pending in outbox (eventId: ${eventId})`
            : 'No outbox entry found for this order',
        tmsDetail,
      },
    };
  }

  async getHistoricalEvents(limit = 50) {
    const [{ orders, outbox }, { shipments }] = await Promise.all([
      this.getOrdersState(),
      this.getShipmentsState(),
    ]);

    const events = [];
    for (const o of orders.slice(-limit)) {
      events.push({
        id: `order-${o.orderId}`,
        timestamp: o.createdAt,
        type: 'ORDER_CREATED',
        service: 'backend',
        status: 'SUCCESS',
        message: `Order ${o.orderId} accepted for ${o.customerId}`,
      });
    }
    for (const entry of outbox.slice(-limit)) {
      if (entry.publishedAt && entry.event) {
        events.push({
          id: `outbox-${entry.event.eventId}`,
          timestamp: entry.publishedAt,
          type: 'ORDER_EVENT_PUBLISHED',
          service: 'rabbitmq',
          status: 'SUCCESS',
          message: `Published ${entry.event.eventType} for order ${StateReader.orderIdOfEvent(entry.event)}`,
        });
      }
    }
    for (const s of shipments.slice(-limit)) {
      events.push({
        id: `shipment-${s.shipmentId}`,
        timestamp: s.createdAt,
        type: 'SHIPMENT_CREATED',
        service: 'mock-tms',
        status: 'SUCCESS',
        message: `Shipment ${s.shipmentId} created for order ${s.orderId}`,
      });
    }

    return events
      .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))
      .slice(0, limit);
  }
}

module.exports = { StateReader };
