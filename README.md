# ABC Retail System Integration - Phase 2

Local demonstration of synchronous, asynchronous, and batch integration using the Phase 1 architecture: Kong Gateway, a Node.js/Express integration layer, RabbitMQ, WMS and E-commerce endpoints.

## Architecture

```text
Client -> Kong -> Inventory Process API -> WMS System API adapter
E-commerce -> Order API -> durable JSON outbox -> RabbitMQ topic exchange
                                                   ├─ Payment consumer
                                                   ├─ WMS consumer -> bounded retry queue -> WMS DLQ
                                                   └─ Notification consumer
Product source -> batch scheduler/CLI -> E-commerce REST endpoint
```

The inventory Process API is the only public route for stock lookup; the WMS adapter is internal to the integration layer. `WMS_MODE=mock` enables a small in-process adapter for a few sample SKUs. Set `WMS_MODE=http` to call a WMS System API that returns `{ "sku": "...", "availableQuantity": 0 }` from `GET {WMS_BASE_URL}/inventory/{sku}`.

Order persistence and consumer deduplication use atomic local JSON file replacement under `STATE_DIR`. This is intended for a single-instance classroom demo, not multi-instance or production deployment. Payment, WMS reservation and notification consumers currently log/mock their downstream action; they have separate RabbitMQ queues and channels. The outbox remains pending if RabbitMQ is unavailable and is retried after reconnect. RabbitMQ publisher confirms and persistent queues/messages are enabled.

For WMS consumer failures, each failure is sent to a durable retry queue with a configurable TTL (`WMS_RETRY_DELAY_MS`). It returns to the WMS queue through a dedicated retry exchange and does not re-broadcast to the other consumers. `x-retry-count` allows three retries after the initial attempt; the fourth failed attempt is copied to `wms.order-created.dlq` and the original is acknowledged only after the copy is confirmed. Payment and notification failures go to their own DLQs without retry. A failed consumer is isolated to its own channel.

Batch delivery posts `{ runId, batchNumber, products }` and considers any 2xx response successful. Failed payloads are durably saved under `STATE_DIR/batch-failures` for manual replay. The target should use `runId` and `batchNumber` as an idempotency key if it can receive a request but its response is lost.

## Requirements and setup

- Node.js 20+ and npm.
- RabbitMQ for order event delivery (enable the Management plugin to inspect queues, retries and DLQs).
- Kong Gateway for gateway proxy and rate-limit verification.
- A WMS System API and E-commerce product batch endpoint for non-mock integration.

RabbitMQ, Kong and Docker were not installed in the inspected environment. They are intentionally not bundled or installed by this project. The API can start without RabbitMQ and keep new orders in its local outbox, but event delivery, the Kong rate limit, and external E-commerce delivery require their respective services.

```powershell
Copy-Item .env.example .env
npm install
npm test
npm start
```

`RABBITMQ_URL` should point to a local or reachable RabbitMQ instance. For remote use, provide credentials via the environment rather than committing them to `.env.example` or source control. The included sample URL is for an unauthenticated localhost URL; configure it to match the local broker's credentials/access policy.

## Synchronous inventory API

- `GET http://localhost:3000/api/v1/inventory/SKU123`
- `GET http://localhost:3000/docs` — Swagger UI
- `GET http://localhost:3000/openapi.json` — OpenAPI 3.0 document
- `GET http://localhost:3000/health`

In mock mode, `SKU123` returns 50 units, `SKU-LOW-STOCK` returns 2, and `SKU-OUT-OF-STOCK` returns 0. Unknown SKUs return 404. HTTP WMS timeouts return 504; unavailable WMS and invalid WMS responses return explicit 503/502 errors.

`kong/kong.yml` is a Kong DB-less declarative configuration. It proxies `/api/v1` to the Process API at `127.0.0.1:3000` and applies the OSS `rate-limiting` plugin at the service: 100 requests per minute per client IP using the local policy. This policy is appropriate for a single local Kong node; a multi-node deployment needs a shared rate-limit policy. Load this file as Kong's declarative config with `database=off`, then call the same inventory URL through Kong's proxy listener. `/docs` is currently served directly by the integration API.

## Asynchronous order API

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/api/v1/orders `
  -ContentType 'application/json' `
  -Body '{"customerId":"customer-1001","items":[{"sku":"SKU123","quantity":2}]}'
```

The response is `202 Accepted` after the order and `order.created` outbox event have been persisted. Queue topology:

| Consumer | Queue | Failure destination |
| --- | --- | --- |
| Payment | `payment.order-created` | `payment.order-created.dlq` |
| WMS | `wms.order-created` | retry queue `wms.order-created.retry`, then `wms.order-created.dlq` |
| Notification | `notification.order-created` | `notification.order-created.dlq` |

Inspect the queues and message rates using RabbitMQ Management. To demonstrate WMS retry/DLQ, set `WMS_FAIL_SKU=SKU123`, restart the API, submit an order containing `SKU123`, and wait for the configured retry delays. It will be sent to the WMS DLQ after four failed attempts total. Remove the setting to resume normal mock processing. The `x-retry-count` header is bounded at 3; no retry queue routes back to the general event exchange.

## Batch product integration

`data/products.json` contains 200 sample records. Set `BATCH_TARGET_URL` to a REST receiver accepting `POST` requests with `{ runId, batchNumber, products }`.

Run a batch immediately:

```powershell
npm run batch:run
```

Replay persisted failures after the receiver is available:

```powershell
npm run batch:run -- retry
```

Run the scheduler as a separate process; it executes daily at midnight in `BATCH_CRON_TIMEZONE` (default `Asia/Ho_Chi_Minh`):

```powershell
npm run batch:scheduler
```

Each request contains at most 100 records. A failed batch is saved in `state/batch-failures` and later batches continue. The run command exits unsuccessfully if any batch failed; the saved payload is retained until a retry succeeds.

## Dependencies

- `express`: API routing and HTTP server.
- `amqplib`: RabbitMQ connections, channels, confirms, acknowledgements and queue topology.
- `node-cron`: local daily batch schedule.
- `csv-parse`: CSV parsing with quoted fields and escaped values.
- `swagger-ui-express`: interactive OpenAPI documentation.
- `dotenv`: local `.env` loading.

The implementation uses built-in Node.js `fetch`, filesystem, crypto and test runner rather than extra HTTP, logging, UUID or testing dependencies.

## Validation status

`npm test` covers inventory success/not-found/WMS timeout/invalid data, order acceptance and durable outbox behavior, consumer deduplication, bounded retry decisions, CSV/JSON reading, 100-record batching, REST delivery, and failed-batch replay. RabbitMQ, Kong rate limiting, and the actual daily midnight execution still require those external services/runtimes and should not be considered end-to-end verified until run in an environment that provides them.
