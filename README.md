# ABC Retail System Integration - Phase 2

Local demonstration of synchronous, asynchronous, and batch integration patterns for the ABC Retail case study.

## Contents

- [Project overview](#project-overview)
- [Architecture](#architecture)
- [Phase 2 integration patterns](#phase-2-integration-patterns)
  - [Synchronous inventory lookup](#1-synchronous-inventory-lookup)
  - [Asynchronous order processing](#2-asynchronous-order-processing)
  - [Batch product integration](#3-batch-product-integration)
- [Technology stack](#technology-stack)
- [Project structure](#project-structure)
- [Installation and configuration](#installation-and-configuration)
- [API documentation and local checks](#api-documentation-and-local-checks)
- [Implementation status and limitations](#implementation-status-and-limitations)
- [Automated tests](#automated-tests)

## Project overview

ABC Retail has stores and an e-commerce channel that need to exchange inventory, order, and product data with business systems such as CRM, WMS, POS, and TMS. This project demonstrates a Phase 2 integration layer; it is not a complete implementation of every ABC Retail system.

The code currently provides:

- An Express Process API for inventory lookup and order acceptance.
- A WMS inventory adapter with an in-process mock mode and an HTTP Mock WMS API.
- RabbitMQ publishing and independent Payment, WMS, Notification, and TMS event consumers.
- An HTTP Mock TMS API with idempotent shipment persistence.
- A file-based order outbox and local consumer-event deduplication.
- A product batch job that posts to a configured REST endpoint.
- OpenAPI documentation and a declarative Kong configuration.

CRM, POS, and the e-commerce application are not implemented as services in this repository. Payment processing, WMS reservation, and customer notifications are simulated by logging. The TMS consumer calls the local Mock TMS HTTP API; it does not integrate with an external carrier or production TMS.

## Architecture

The design combines API-led connectivity for request/response APIs with event-driven messaging for order processing:

```text
Inventory client -> (optional) Kong -> Inventory Process API -> WMS adapter -> Mock WMS HTTP API
E-commerce client -> Order API -> Inventory Service -> JSON outbox -> RabbitMQ
                                                               ├─ Payment / WMS / Notification consumers
                                                               └─ TMS consumer -> Mock TMS HTTP API -> shipment state
Product file (CSV or JSON) -> batch scheduler or CLI -> configured product REST target
```

The public inventory route is the Process API. Clients do not call the WMS adapter directly. `kong/kong.yml` provides a DB-less Kong service and route for `/api/v1`; the backend can also be called directly on its configured port.

## Phase 2 integration patterns

### 1. Synchronous inventory lookup

The inventory request path is:

```text
Client -> Kong API Gateway -> Inventory Process API -> WMS System API adapter
```

- Endpoint: `GET /api/v1/inventory/{sku}`
- OpenAPI 3.0.3 definition: `openapi/openapi.json`
- Swagger UI: `/docs`
- Health check: `/health`
- Successful response: `{ "success": true, "data": { "sku": "...", "availableQuantity": 50 } }`
- `WMS_MODE=mock` uses the in-process sample inventory. `WMS_MODE=http` calls `{WMS_BASE_URL}/inventory/{sku}`; the included Mock WMS implements `GET /api/v1/wms/inventory/{sku}`.
- Invalid SKUs return 400; missing SKUs return 404; invalid WMS responses return 502; unavailable WMS and request timeouts return 503 and 504 respectively.

Kong configuration applies the OSS `rate-limiting` plugin at 100 requests per minute per client IP using the local policy. This limit applies when traffic passes through Kong, not when clients call Express directly. The repository contains the declarative Kong file, not a Kong deployment.

### 2. Asynchronous order processing

`POST /api/v1/orders` validates the request and checks each SKU through the Inventory Service before persisting anything. Duplicate SKU lines are summed for the availability check. Insufficient stock returns `409` without an Order or outbox entry. If all SKUs have sufficient stock, the order and `order.created` event are persisted together and the API returns `202 Accepted`.

The publisher sends the event to RabbitMQ with persistent delivery and publisher confirms. The outbox entry is marked published after confirmation; if RabbitMQ is unavailable, the event remains pending for a later connection/reconnect attempt.

The runtime declares three durable exchanges:

| Exchange | Type | Purpose |
| --- | --- | --- |
| `abc.events` | topic | Routes `order.created` to the three consumer queues |
| `abc.dead-letter` | direct | Routes failed messages to consumer-specific DLQs |
| `abc.wms.retry` | direct | Routes expired WMS retry messages back to the WMS queue |
| `abc.tms.retry` | direct | Routes expired TMS retry messages back to the TMS queue |

Each consumer has its own queue and channel:

| Consumer | Main queue | Failure destination |
| --- | --- | --- |
| Payment | `payment.order-created` | `payment.order-created.dlq` |
| WMS | `wms.order-created` | `wms.order-created.retry`, then `wms.order-created.dlq` |
| Notification | `notification.order-created` | `notification.order-created.dlq` |
| TMS | `tms.order-created` | `tms.order-created.retry`, then `tms.order-created.dlq` |

The main queues bind to `abc.events` with routing key `order.created`. Payment, WMS, and Notification retain their current mock/log behavior. The TMS consumer calls `POST /api/v1/tms/shipments`; the Mock TMS stores shipment records in `state/tms/shipments.json`. A repeated `eventId` returns the existing shipment instead of creating a duplicate. Successfully processed event IDs are also stored per consumer.

#### WMS retry and DLQ

- `WMS_RETRY_DELAY_MS` sets the WMS and TMS retry queue TTL; the default is **5000 ms**.
- The policy allows **3 retries after the initial attempt**: at most **4 processing attempts**.
- After each of the first three WMS or TMS failures, the event is republished to that consumer's retry queue with an incremented `x-retry-count`. On TTL expiry, RabbitMQ routes it back to that consumer's main queue through its dedicated retry exchange.
- If the fourth attempt also fails, the event is sent to that consumer's DLQ.
- The failed original is acknowledged only after the retry/DLQ copy is publisher-confirmed. If routing fails, the original is rejected to its configured DLQ rather than endlessly requeued.
- Set `WMS_FAIL_SKU` to a SKU to simulate a WMS reservation failure for orders containing that exact SKU. This setting is read at Backend startup; restart the Backend after changing it. It affects the asynchronous WMS handler, not the synchronous inventory mock.

### 3. Batch product integration

The batch job reads a JSON or CSV product array from `BATCH_INPUT_FILE` and sends it to `BATCH_TARGET_URL` as REST requests:

```json
{
  "runId": "...",
  "batchNumber": 1,
  "products": []
}
```

- Each request contains at most 100 products.
- Any 2xx target response counts as a successful batch.
- A failed batch payload is saved under `STATE_DIR/batch-failures`; later batches continue.
- Run saved failures again with `npm run batch:run -- retry`. A saved file is removed after a successful replay.
- The separate scheduler uses `0 0 * * *` (midnight) in `BATCH_CRON_TIMEZONE`, which defaults to `Asia/Ho_Chi_Minh`. It skips an overlapping run.
- `data/products.json` is the included sample input. No E-commerce batch receiver is included; configure a reachable REST target before running the batch.

## Technology stack

| Technology | Use |
| --- | --- |
| Node.js 20+ and JavaScript | Backend and batch runtime |
| Express.js | HTTP APIs |
| RabbitMQ and `amqplib` | Order events, confirms, queues, acknowledgements, retry, and DLQ |
| Kong Gateway | Optional API gateway, configured in `kong/kong.yml` |
| OpenAPI 3.0.3 and `swagger-ui-express` | API contract and interactive documentation |
| `dotenv` | Load local environment configuration |
| `node-cron` | Daily batch schedule |
| `csv-parse` | CSV product input |
| Node.js built-ins | Fetch, filesystem, crypto, logging, and test runner |

The repository does not include a Backend Dockerfile or a full-stack Docker Compose file. A dedicated `docker-compose.kong.yml` can run Kong independently; RabbitMQ remains separately managed.

## Project structure

```text
.
├── data/
│   └── products.json             # Sample batch input
├── docker-compose.kong.yml       # Isolated DB-less Kong Gateway
├── kong/
│   └── kong.yml                  # DB-less Kong service, route, and rate limit
├── openapi/
│   └── openapi.json              # OpenAPI contract
├── src/
│   ├── batch/                    # Reader, batching, REST sender, CLI, scheduler
│   ├── controllers/              # HTTP request handlers
│   ├── integrations/wms/         # Synchronous inventory adapter
│   ├── messaging/                # RabbitMQ topology, consumers, retry policy/runtime
│   ├── repositories/             # JSON order, outbox, and consumer-event stores
│   ├── routes/                   # Inventory and order routes
│   ├── services/                 # Inventory, order, and outbox services
│   ├── app.js                    # Express app and API documentation routes
│   ├── config.js                 # Environment loading and configuration
│   └── server.js                 # Backend startup and RabbitMQ runtime
├── state/                        # Local runtime state; ignored by Git
├── tests/                        # Node.js automated tests
├── .env.example                  # Safe local configuration defaults
├── package.json
└── README.md
```

## Installation and configuration

### Requirements

- Node.js 20 or later and npm.
- RabbitMQ for order event delivery.
- Kong only if testing the gateway route and rate limit.
- A reachable WMS System API only when using `WMS_MODE=http`.
- A reachable product REST receiver only when running batch delivery.

### Install

```powershell
git clone <repository-url>
Set-Location CodeDemo_SE445C
npm install
Copy-Item .env.example .env
```

Replace `<repository-url>` with the URL for your repository. Keep `.env` local and do not commit credentials.

### Environment variables

| Variable | Default | Required when / purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `WMS_MODE` | `mock` | `mock` or `http` for synchronous inventory lookup |
| `WMS_BASE_URL` | `http://127.0.0.1:3100/api/v1/wms` | Required for a reachable WMS when `WMS_MODE=http` |
| `WMS_TIMEOUT_MS` | `3000` | Synchronous WMS request timeout |
| `WMS_MOCK_PORT` | `3100` | Mock WMS HTTP API listen port |
| `WMS_MOCK_INVENTORY` | Sample SKU-to-quantity JSON | Mock inventory map; omit a SKU to make it not found |
| `RABBITMQ_URL` | `amqp://localhost:5672` | Set to the broker URL for asynchronous delivery |
| `RABBITMQ_RECONNECT_MS` | `3000` | RabbitMQ reconnect delay |
| `WMS_RETRY_DELAY_MS` | `5000` | WMS and TMS retry queue TTL |
| `WMS_FAIL_SKU` | empty | Optional exact-match WMS failure simulation for testing |
| `TMS_BASE_URL` | `http://127.0.0.1:3300/api/v1/tms` | Mock or external TMS base URL |
| `TMS_TIMEOUT_MS` | `3000` | TMS shipment request timeout |
| `TMS_MOCK_PORT` | `3300` | Mock TMS HTTP API listen port |
| `STATE_DIR` | `state` | Local JSON state directory |
| `BATCH_INPUT_FILE` | `data/products.json` | CSV or JSON product input |
| `BATCH_TARGET_URL` | empty in code; local URL in `.env.example` | Set to a reachable batch receiver before running batch |
| `BATCH_TIMEOUT_MS` | `10000` | Batch HTTP timeout |
| `BATCH_CRON_TIMEZONE` | `Asia/Ho_Chi_Minh` | Time zone for the midnight schedule |

`dotenv` loads `.env` from the process working directory. If RabbitMQ requires authentication, configure `RABBITMQ_URL` with the credentials for your broker in the local `.env`; URL-encode reserved characters in credentials. Do not copy real credentials into this README or `.env.example`.

### RabbitMQ and Kong

The project does not start or configure containers. Start RabbitMQ separately and make AMQP port `5672` reachable. Enable its Management plugin and expose port `15672` if you want to inspect exchanges, queues, and DLQs. Configure the local broker credentials and matching `RABBITMQ_URL` outside source control.

For a new local broker only, an illustrative Docker command is:

```powershell
docker run -d --name abc-rabbitmq `
  -p 5672:5672 -p 15672:15672 `
  -e RABBITMQ_DEFAULT_USER=local_dev `
  -e RABBITMQ_DEFAULT_PASS=replace-with-a-local-password `
  rabbitmq:management
```

Replace the sample password with a local-only value and configure the same credentials in `.env`; URL-encode reserved characters in `RABBITMQ_URL`. The root vhost `/` is represented as `%2F` in the URL path. Do not run this command if a broker container with that name already exists. The repository does not pin or manage the RabbitMQ image version.

#### Run the isolated Kong Gateway

The separate Compose file uses the official Kong OSS image pinned to `kong:3.9.4`, runs DB-less, mounts `kong/kong.yml` read-only, and publishes only the HTTP proxy on port `8000`. It does not define or connect to a RabbitMQ or Backend container. The Admin API is not published to the host.

Before starting Kong, make sure the Backend is already running on the Windows host at port `3000`. The declarative service upstream uses `http://host.docker.internal:3000`, which resolves from the Kong container to the host.

From the project root, validate the Compose configuration and start Kong:

```powershell
docker compose -f docker-compose.kong.yml config
docker compose -f docker-compose.kong.yml up -d
docker compose -f docker-compose.kong.yml ps
```

The proxy URL is `http://localhost:8000`; for example, the Order API path through Kong is `/api/v1/orders`. To inspect Kong startup logs:

```powershell
docker compose -f docker-compose.kong.yml logs --tail 100 kong
```

Stop only this Kong deployment with:

```powershell
docker compose -f docker-compose.kong.yml down
```

Do not add `-v`. This Compose file defines no persistent volumes and does not alter the existing RabbitMQ container or queues.

### Start services

For an HTTP-based Scenario 1, set these values in the local `.env` (do not use production URLs):

```dotenv
WMS_MODE=http
WMS_BASE_URL=http://127.0.0.1:3100/api/v1/wms
TMS_BASE_URL=http://127.0.0.1:3300/api/v1/tms
```

In separate PowerShell terminals, start the mocks and then the Backend:

```powershell
npm run mock:wms
```

```powershell
npm run mock:tms
```

```powershell
npm start
```

The Backend starts the HTTP API and attempts RabbitMQ connection/reconnection. The API can start while RabbitMQ is unavailable, but orders will remain in the local outbox until publishing succeeds. Check the `RabbitMQ connected and consumers are ready` log and broker consumer counts before relying on event delivery. Start RabbitMQ separately; these scripts do not start or stop broker containers.

The batch scheduler is a separate process:

```powershell
npm run batch:scheduler
```

## API documentation and local checks

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Backend health |
| `GET` | `/api/v1/inventory/{sku}` | Inventory lookup through the Process API |
| `POST` | `/api/v1/orders` | Persist and accept an order for asynchronous processing |
| `GET` | `http://localhost:3100/api/v1/wms/inventory/{sku}` | Mock WMS inventory (port is configurable) |
| `POST` | `http://localhost:3300/api/v1/tms/shipments` | Create or retrieve an idempotent Mock TMS shipment |
| `GET` | `/openapi.json` | OpenAPI document |
| `GET` | `/docs` | Swagger UI |

The Order API validates a non-empty `customerId` string and at least one item with a valid SKU and positive integer quantity. It does not look up the customer in a CRM or customer registry.

To check the Scenario 1 flow, start both mocks and the Backend with `WMS_MODE=http`; submit an order containing a SKU present in `WMS_MOCK_INVENTORY` and a quantity no greater than its available count. Confirm the Order response, `order.created` event/consumer activity in RabbitMQ Management, and the shipment log or `state/tms/shipments.json`.

To observe retry/DLQ, configure `WMS_FAIL_SKU` to a test SKU or stop the Mock TMS process in a controlled environment. WMS and TMS have separate retry queues and DLQs. Do not use production order or customer data. Stopping Mock TMS to run Scenario 3 is a separate test and is not performed automatically.

### Check the API

Run the unit/integration test suite:

```powershell
npm test
```

Check health and synchronous inventory in mock mode:

```powershell
Invoke-RestMethod -Uri http://localhost:3000/health
Invoke-RestMethod -Uri http://localhost:3000/api/v1/inventory/SKU123
```

To submit an order, provide an approved non-production customer identifier when prompted. This command creates persistent local order/outbox state and, when RabbitMQ is connected, publishes an event:

```powershell
$customerId = Read-Host "Customer ID for this test"
$body = @{
  customerId = $customerId
  items = @(@{ sku = "SKU123"; quantity = 1 })
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/api/v1/orders `
  -ContentType "application/json" `
  -Body $body
```

To observe WMS retry/DLQ, configure `WMS_FAIL_SKU` to the same test SKU in local `.env`, restart the Backend, and submit one controlled test order containing that SKU. Inspect the retry/DLQ queues in RabbitMQ Management. Do not use production order or customer data.

Run batch delivery manually after configuring a reachable `BATCH_TARGET_URL`:

```powershell
npm run batch:run
```

Replay persisted failures:

```powershell
npm run batch:run -- retry
```

## Implementation status and limitations

| Area | Implemented | Status and boundary |
| --- | --- | --- |
| Inventory API | Express route, validation, OpenAPI/Swagger, WMS adapter, Kong configuration | WMS mock and HTTP adapter exist. Kong's live rate limit depends on an external Kong deployment. |
| Order integration | Order API, JSON outbox, RabbitMQ publisher confirms, three independent queues/consumers, ACK/NACK, deduplication, retry, and DLQ | Payment, WMS reservation, and Notification handlers currently log/simulate downstream actions; they do not integrate with external business systems. |
| Product batch | CSV/JSON input, batches up to 100, REST delivery, persisted failure payloads, manual replay, cron scheduler | A target receiver must be supplied. The scheduler is separate from `npm start`. |
| Other ABC Retail systems | Not included | CRM, POS, TMS, external Payment, real WMS order reservation, email/Zalo delivery, and the E-commerce receiver are not implemented here. |
| Deployment and security | Not included | No Dockerfile, Compose deployment, authentication, or production multi-instance persistence is provided. JSON state is intended for a single-instance classroom demo. |

The automated tests use local test doubles and temporary HTTP servers; they do not prove a live Kong deployment or external business-system integration. A controlled local RabbitMQ run on 2026-11-15 verified order publication, Payment and Notification acknowledgements, and WMS retry/DLQ behavior: four failed WMS attempts, three retries at the configured 5-second delay, and one message in the WMS DLQ. This is an environment-specific manual check, not a guarantee about another broker or configuration. The actual midnight scheduler execution and Kong rate limiting were not verified as live deployments.

## Automated tests

`npm test` uses the built-in Node.js test runner and covers:

- Inventory success, missing SKU, invalid WMS data, and timeout mapping.
- Order acceptance, outbox persistence, outbox failure behavior, consumer deduplication, and the bounded retry policy.
- CSV/JSON product loading, splitting 200 records into two batches of 100, sample catalog validation, REST delivery, and failed-batch replay.

These tests do not start a live RabbitMQ broker, Kong, WMS, CRM, Payment, Notification, or E-commerce service.
