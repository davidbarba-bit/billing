# mini-lago

Self-hosted, Lago-compatible billing engine — a re-implementation (not a wrapper)
of the [Lago](https://github.com/getlago/lago) REST API surface used by
`lago-javascript-client`.

> Status: **phase 1** — bootstrap, schema, `customers`, and `taxes` resources.
> Billing engine (events, plans, subscriptions, current usage, invoices,
> credit notes, webhooks, period cron) lands in subsequent phases.

## Why

`getlago/lago` is a great product but heavy (Ruby on Rails + multiple services).
For the Numaris Billing telemetry use case we only need a strict subset of the
HTTP surface, with predictable cost-per-event behavior, multi-tenant isolation,
deterministic idempotency, and drop-in compatibility with the official
`lago-javascript-client` SDK.

## Stack

- Node 22 / TypeScript 5.9 (`strict`, no `any`)
- Express 5
- PostgreSQL 16 + Drizzle ORM
- Zod v4 input/output validation
- Pino structured logging (one logger per request)
- Vitest unit + integration tests

## Running locally

```bash
# 1. Bring up postgres
docker compose up -d postgres

# 2. Apply schema
DATABASE_URL=postgres://lago:lago@localhost:5432/lago npm run db:push

# 3. Start the API
cp .env.example .env
npm install
npm run dev
```

The service listens on `http://localhost:3000`. `GET /healthz` returns
`{ "status": "ok" }`; every other resource lives under `/api/v1`.

### docker-compose (api + postgres)

```bash
docker compose up --build
```

## Authentication

Each entry in `LAGO_API_KEYS` is one tenant/organization:

```
LAGO_API_KEYS=key_prod_123:numaris:Numaris Inc.,key_dev_456:acme
```

- Format: `api_key:slug[:org_name]`
- Every request must include `Authorization: Bearer <api_key>`
- The API key is hashed with SHA-256 before it touches Postgres; the plaintext
  never lands in the DB.
- On boot the service `INSERT ... ON CONFLICT DO NOTHING` an organization row
  per key, so adding keys is hot-reload safe.

## Using the official SDK

```ts
import { Client } from "lago-javascript-client";

const lago = Client(process.env.LAGO_API_KEY!, {
  baseUrl: "http://localhost:3000/api/v1",
});

const { data } = await lago.customers.createCustomer({
  customer: {
    external_id: "cust_001",
    name: "Acme",
    currency: "USD",
    timezone: "America/Mexico_City",
  },
});
console.log(data.customer.lago_id);
```

The integration tests in `tests/integration/*.test.ts` use the real SDK
against a real Postgres — see `tests/helpers/lago-sdk.ts`.

## Implemented endpoints (phase 1)

| Method | Path | SDK call |
| - | - | - |
| `POST` | `/api/v1/customers` | `lago.customers.createCustomer` |
| `GET` | `/api/v1/customers` | `lago.customers.findAllCustomers` |
| `GET` | `/api/v1/customers/:external_id` | `lago.customers.findCustomer` |
| `DELETE` | `/api/v1/customers/:external_id` | `lago.customers.destroyCustomer` |
| `POST` | `/api/v1/taxes` | `lago.taxes.createTax` |
| `GET` | `/api/v1/taxes` | `lago.taxes.findAllTaxes` |
| `GET` | `/api/v1/taxes/:code` | `lago.taxes.findTax` |
| `DELETE` | `/api/v1/taxes/:code` | `lago.taxes.destroyTax` |
| `GET` | `/healthz` | (internal health check) |

### Customer semantics

- **Strict create** on `(organization_id, external_id)`: matches Lago's real
  behavior. A second `POST` with the same `external_id` returns
  `422 validation_errors` with
  `error_details.external_id: ["value_already_exist"]`.
- `tax_codes: ["iva-mx-16"]` at create time links the customer to the listed
  taxes (validated against existing taxes; unknown codes → 422).
- Response shape matches Lago's canonical customer (all nullable fields
  present, `metadata: []`, `taxes: [...]` embedded, `billing_configuration`
  and `shipping_address` with default null keys, `applicable_timezone` falls
  back to `"UTC"`).
- `sequential_id` is per-org auto-increment; `slug` is `{ORG3}-{HASH4}-{NNN}`
  (e.g. `NUM-FC2D-009`).
- Soft delete: `DELETE` flips `deleted_at` and subsequent reads return 404.

### Tax semantics

- **Strict create** on `(organization_id, code)` — duplicates return
  `422 validation_errors` with
  `error_details.code: ["value_already_exist"]` (matches Lago).
- `rate` accepts both string (`"16"`) and number (`16`); always returned as
  a number.
- `applied_to_organization: true` links the tax to every customer in the org
  (existing **and** future). The link lives in the `customer_taxes` table.
- Counters (`customers_count`, `add_ons_count`, `plans_count`,
  `charges_count`, `commitments_count`) are computed on the fly. Until the
  corresponding resources land in phase 2-3, the non-customer counters are
  `0`.

## Error shape

Every error response uses the Lago body:

```json
{
  "status": 422,
  "error": "Unprocessable Entity",
  "code": "validation_errors",
  "error_details": { "external_id": ["value_already_exist"] }
}
```

Reason codes inside `error_details.<field>` follow Lago's vocabulary:
`value_already_exist`, `value_is_invalid`, `value_is_blank`,
`value_is_out_of_range`.

| HTTP | `code` | When |
| - | - | - |
| `400` | `malformed_json` | Body isn't valid JSON |
| `401` | `missing_bearer_token` / `invalid_api_key` | Auth |
| `404` | `<resource>_not_found` | Resource lookup miss |
| `422` | `validation_errors` | Schema / duplicate / unknown reference |

## Tests

```bash
# Unit only
npm run test:unit

# Integration (needs Postgres + DATABASE_URL)
DATABASE_URL=postgres://lago:lago@localhost:5432/lago npm run test:integration

# Everything
DATABASE_URL=postgres://lago:lago@localhost:5432/lago npm test
```

Integration tests:

1. Truncate domain tables (orgs are kept so parallel harnesses don't invalidate
   each other's API keys).
2. Mint a new organization with a random API key.
3. Spin a real `express` server on an ephemeral port.
4. Exercise the endpoints with both raw `fetch` and the official SDK.

## Differences vs. upstream Lago (phase 1)

- Only the endpoints listed above are implemented. The billing engine
  (events, plans, subscriptions, invoices, credit notes, webhooks, period
  closing cron) is not yet present — they ship in subsequent phases.
- Pagination is offset-based (`page`, `per_page`); response shape matches
  Lago's `meta` block (`current_page`, `next_page`, `prev_page`,
  `total_pages`, `total_count`).
- API keys are configured statically via `LAGO_API_KEYS` rather than minted by
  an admin UI.

## Layout

```
src/
  index.ts                    # bootstrap
  app.ts                      # express app wiring
  config.ts                   # env parsing (zod)
  db/
    client.ts
    schema/                   # one file per table
  lib/
    auth.ts                   # bearer + tenant resolution
    errors.ts                 # Lago-shaped error helpers
    logger.ts                 # pino logger
    pagination.ts
    async.ts
  routes/
    customers.ts
    taxes.ts
  schemas/                    # zod request/response schemas
    customers.ts
    taxes.ts
tests/
  helpers/{server,http,lago-sdk}.ts
  integration/{customers,taxes}.test.ts
  unit/config.test.ts
```

## Environment variables

| Name | Required | Default | Notes |
| - | - | - | - |
| `DATABASE_URL` | yes | — | Postgres connection string |
| `LAGO_API_KEYS` | yes | — | `key:slug[:name]`, comma-separated |
| `PORT` | no | `3000` | |
| `NODE_ENV` | no | `development` | |
| `LOG_LEVEL` | no | `info` | |
| `WEBHOOK_URL` | no | — | If set, webhook deliveries go here (phase 2) |
| `WEBHOOK_SIGNATURE_KEY` | no | `dev-signature-key` | HMAC key (phase 2) |
| `PERIOD_CLOSE_INTERVAL_MS` | no | `3600000` | Period-close cron interval (phase 2) |
