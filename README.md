# Northline Atlas Dispatch

A trustworthy, production-shaped slice of a vendor-webhook ops platform:

> **signed ingest → persist → tenant-scoped ops UI → retry**

Vendors send **HMAC-signed** webhooks to a NestJS API. The API verifies, de-duplicates, and persists each
event as a **work item** that moves through `pending → done | failed → dead` with bounded retries. Ops
users sign in, inspect events in **their workspace only**, and retry dead items — and can **never** see
another tenant’s data.

Built for correctness over breadth: one path, done properly, with tests and a documented threat model.
See [`NOTES.md`](./NOTES.md) for the threat model, cache/invalidation strategy, crash-safety analysis, and
the week-two backlog.

This repository is **two standalone folders + one README** (as the brief allows):

```
.
├─ api/            NestJS API (PostgreSQL)        → http://localhost:3333
├─ web/            Next.js App Router ops UI      → http://localhost:3000
├─ scripts/        webhook.sh — fake vendor (curl + HMAC)
├─ NOTES.md        threat model, cache, crash-safety, week-two
└─ README.md
```

Each app installs and runs on its own (no monorepo tooling required).

---

## Contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Quickstart](#quickstart)
- [Accounts & workspace URLs](#accounts--workspace-urls)
- [The signed-webhook protocol (HMAC)](#the-signed-webhook-protocol-hmac)
- [Sending webhooks (fake vendor)](#sending-webhooks-fake-vendor)
- [API reference](#api-reference)
- [Auth, RBAC & tenant isolation](#auth-rbac--tenant-isolation)
- [Work-item lifecycle & retry](#work-item-lifecycle--retry)
- [Cache & list freshness](#cache--list-freshness)
- [Testing](#testing)
- [Environments](#environments)
- [Prisma client (`prisma-client` generator)](#prisma-client-prisma-client-generator)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
  vendor (curl + HMAC)                          ops user (browser)
        │                                              │
        │  POST /webhooks/:vendor                      │  cookie: atlas_token (JWT)
        │  X-Webhook-Key, X-Signature                  │
        ▼                                              ▼
┌───────────────────────────┐               ┌───────────────────────────┐
│   NestJS API  (:3333)      │               │  Next.js App Router (:3000)│
│                            │   fetch +     │                            │
│  WebhooksController        │◀──Bearer JWT──│  Server Components (SSR)   │
│   └ verify HMAC, freshness │               │  /w/[workspaceSlug]/events │
│   └ size limit, idempotency│               │   └ list + status filter   │
│  WorkItemsController        │               │   └ detail + history       │
│   └ AuthGuard (JWT)        │               │   └ retry (server action)  │
│   └ PermissionsGuard       │               └───────────────────────────┘
│   └ WorkspaceGuard (tenant)│
│  Prisma 7 (pg adapter)     │
└──────────────┬─────────────┘
               ▼
        PostgreSQL (northline_atlas)
```

Guards resolve **entirely from the JWT** — permissions and workspace memberships are baked into the token
at login, so no guard hits the database on a per-request basis.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| API | **NestJS 11**, TypeScript, Express 5 |
| ORM / DB | **Prisma 7** (`prisma-client` generator + `@prisma/adapter-pg`), PostgreSQL |
| Auth | JWT access token (5 min) + rotating refresh cookie (7 d), bcrypt passwords, RBAC |
| UI | **Next.js 16** App Router, **React 19**, Server Components + server actions |
| Tests | Jest + ts-jest + supertest |
| Tooling | Prettier, Swagger (`/docs`) |

> NestJS 12 (ESM-only) and Prisma 8 (release candidate) exist but break the CJS + ts-jest toolchain, so
> they’re intentionally pinned one major back. Rationale is at the top of [`NOTES.md`](./NOTES.md).

---

## Quickstart

**Prerequisites:** Node ≥ 20 (tested on 24), pnpm ≥ 9, a local PostgreSQL.

Create the database once (or point `DATABASE_URL` at any DB you have):

```bash
createdb northline_atlas   # or: psql -c 'CREATE DATABASE northline_atlas;'
```

### 1) API — `api/` (terminal 1)

```bash
cd api
cp .env.example .env.development      # then set DATABASE_URL to your Postgres
pnpm install
pnpm setup                            # prisma generate → migrate deploy → seed
pnpm start:dev                        # → http://localhost:3333  (Swagger at /docs)
```

`DATABASE_URL` example: `postgresql://USER:PASSWORD@localhost:5432/northline_atlas?schema=public`

### 2) Web — `web/` (terminal 2)

```bash
cd web
cp .env.example .env.local            # API_BASE_URL defaults to http://localhost:3333
pnpm install
pnpm dev                              # → http://localhost:3000
```

Open **http://localhost:3000** and pick a seeded operator.

> Re-run `pnpm prisma:generate` in `api/` after any `pnpm install` — the Prisma client is generated into
> the repo (see [Prisma client](#prisma-client-prisma-client-generator)).

---

## Accounts & workspace URLs

Auth is real JWT. **Demo password for every account: `password`.**

| Operator | Email | Role | Can retry? | Workspace | URL |
| --- | --- | --- | --- | --- | --- |
| Alice | `alice@acme.test` | `ops-admin` | ✅ yes | **acme** (Acme Freight) | http://localhost:3000/w/acme/events |
| Bob | `bob@northline.test` | `ops-viewer` | ❌ no (403) | **northline-shop** (Northline Shop) | http://localhost:3000/w/northline-shop/events |

- **Tenant isolation:** signed in as Alice, visiting `/w/northline-shop/events` returns **404** (never an
  empty list — no existence leak).
- **RBAC:** Bob (viewer) sees a locked “Retry needs ops-admin” hint and the API returns **403** if he
  calls retry directly; Alice (admin) can retry.

---

## The signed-webhook protocol (HMAC)

Implemented in [`api/src/webhooks/hmac.ts`](./api/src/webhooks/hmac.ts).

```
Headers
  X-Webhook-Key: <keyId>                       # identifies the per-workspace credential
  X-Signature:   t=<unixSeconds>,v1=<hexHmac>  # Stripe-style

signedString = `${t}.${rawRequestBody}`
v1           = HMAC_SHA256(secret, signedString)   // lowercase hex
```

- **Tenant is derived from the signing key**, never from the body. `keyId → VendorCredential → workspace`.
  A body claiming `"workspace":"acme"` is ignored.
- Verified against the **exact raw bytes** (captured before JSON parsing) with a **constant-time** compare.
- The timestamp is inside the signed string, so an old body can’t be replayed with a fresh `t`.

**Rejections:** missing/malformed signature or key → `401` · bad signature → `401` ·
stale (`|now − t| > 300s`) → `401` · vendor ≠ credential’s vendor → `401` · missing `id` → `422` ·
body > 64 KiB → `413`.

---

## Sending webhooks (fake vendor)

With the API running:

```bash
# Full demo: valid, duplicate (idempotent), bad signature, fail→dead, stale, oversized
./scripts/webhook.sh

# Send one custom event (simulate = ok | fail | fail-until:N)
./scripts/webhook.sh send evt_manual_1 ok
./scripts/webhook.sh send evt_manual_2 fail           # → bounded retries → dead
./scripts/webhook.sh send evt_manual_3 fail-until:2   # fails once, then succeeds

# Target another tenant’s credential:
KEY_ID=northline_stripe_key SECRET=whsec_northline_stripe_dev VENDOR=stripe \
  ./scripts/webhook.sh send evt_north_manual_1 ok
```

Seeded vendor credentials (also in [`scripts/webhook.sh`](./scripts/webhook.sh)):

| keyId | vendor | workspace | secret |
| --- | --- | --- | --- |
| `acme_stripe_key` | stripe | acme | `whsec_acme_stripe_dev` |
| `acme_shipping_key` | shipping | acme | `whsec_acme_shipping_dev` |
| `northline_stripe_key` | stripe | northline-shop | `whsec_northline_stripe_dev` |

### Raw curl (no script)

Compute the signature with `openssl` and post:

```bash
SECRET="whsec_acme_stripe_dev"
KEY="acme_stripe_key"
BODY='{"id":"evt_manual_1","type":"charge.succeeded","amount":4200,"simulate":"ok"}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')

curl -i -X POST http://localhost:3333/webhooks/stripe \
  -H "content-type: application/json" \
  -H "x-webhook-key: $KEY" \
  -H "x-signature: t=$T,v1=$SIG" \
  -d "$BODY"
```

- Sign the **exact bytes** you send in `-d` (don’t reformat the JSON after signing).
- Send twice with the same `id` → the second is `"duplicate"` (one work item). Tamper the body, drop a
  header, or use a `T` older than 5 min → `401`. Omit `id` → `422`. Path is `/webhooks/stripe` (no `/api`).

---

## API reference

The app API is under **`/api`**; the vendor ingest path and health stay at the root so the brief’s
documented `POST /webhooks/:vendor` is exact.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/webhooks/:vendor` | HMAC | Signed ingest. `200` accepted/duplicate; `401/413/422` on reject. |
| `POST` | `/api/auth/login` | public | `{email,password}` → `{accessToken, permissions}` + refresh cookie. |
| `POST` | `/api/auth/refresh` | refresh cookie | New access token (rotation). |
| `POST` | `/api/auth/logout` | refresh cookie | Revokes the stored refresh token. |
| `GET` | `/api/me` | JWT | Current user + permissions + memberships (from the token). |
| `GET` | `/api/workspaces/:slug` | JWT | Workspace header info (`404` if not a member). |
| `GET` | `/api/workspaces/:slug/work-items?status=&vendor=` | JWT + `workitem:read` | Scoped list + filters. |
| `GET` | `/api/workspaces/:slug/work-items/:id` | JWT + `workitem:read` | Detail: redacted payload + status history. |
| `POST` | `/api/workspaces/:slug/work-items/:id/retry` | JWT + `workitem:retry` | Operator retry of a dead/failed item. |
| `GET` | `/api/dev/accounts` | public | **Dev-only** — backs the one-click login picker. |
| `GET` | `/health` | public | Liveness. |

Every response is wrapped in `{ statusCode, message, data, meta }` by a global interceptor; errors keep
their real HTTP status via a global exception filter. Interactive docs: **http://localhost:3333/docs**
(HTTP Basic auth — `SWAGGER_USER` / `SWAGGER_PASSWORD` from the env file; dev = `admin` / `atlas_docs_dev`).

---

## Auth, RBAC & tenant isolation

Three concerns, cleanly separated (all resolved from the JWT — **zero DB queries in guards**):

1. **Authentication** — [`AuthGuard`](./api/src/auth/jwt/jwt.guard.ts) verifies the Bearer access token and
   populates `req.user` from the decoded payload. Routes marked
   [`@Public()`](./api/src/auth/decorators/public.decorator.ts) (login, webhooks, health, dev) skip it.
2. **Authorization** — [`PermissionsGuard`](./api/src/auth/permission/permission.guard.ts) enforces the
   route’s [`@Permissions(...)`](./api/src/auth/decorators/permissions.decorator.ts) against the token’s
   permission list. Permissions: `workitem:read`, `workitem:retry`.
3. **Tenancy** — [`WorkspaceGuard`](./api/src/auth/workspace.guard.ts) matches the `:slug` against the
   token’s **membership claims** (`{workspaceId, slug, name, role}[]`) and attaches `req.workspace`.
   Non-member **and** unknown slug both return **404** — existence never leaks. Every query is filtered by
   `req.workspace.id`, never the raw slug.

At login/refresh, [`AuthService.buildPrincipal`](./api/src/auth/auth.service.ts) reads the user’s roles →
permissions and memberships **once** and embeds them in the JWT. Membership/role changes take effect on
the next token mint; with a 5-minute access TTL that staleness window is small. The **UI never bundles
other tenants’ data**: all reads are server-side and scoped by the session cookie.

---

## Work-item lifecycle & retry

```
received ──▶ pending ──▶ (attempt) ──▶ done
                            │
                            ├─ fail, attempts < max ──▶ failed ──▶ (retry) ─┐
                            └─ fail, attempts ≥ max ──▶ dead                 │
                                                          ▲                  │
                                          operator retry ─┘◀────────────────┘
```

- **One event → one work item.** Idempotency is a unique constraint on `(workspaceId, vendor, vendorEventId)`;
  a vendor retry returns the existing work item (`outcome: "duplicate"`).
- **Bounded retries.** `attempts` vs `maxAttempts` (default 3). The handler is simulated deterministically
  via a payload `simulate` field (`ok` | `fail` | `fail-until:N`).
- **Operator retry** (dead/failed only) grants a fresh attempt budget and re-runs the loop, recording every
  transition in an append-only `StatusTransition` history shown on the detail page.
- **Logs** carry `tenantId · vendor · eventId` (+ `keyId`/`outcome` on ingest) and never raw secrets;
  detail payloads are redacted of secret-looking keys.

---

## Cache & list freshness

- **Operator retry (in-app):** a **server action** calls the API then `revalidatePath()` on the list and
  detail, and the client `router.refresh()`s — the new status shows immediately.
- **New webhook (external):** reads are `cache: 'no-store'` (`force-dynamic`), so the list is
  server-rendered fresh on every navigation/reload.

The workspace shell resolves the tenant **before** rendering, so a slow list never flashes the wrong
workspace name (stretch goal). Full discussion in [`NOTES.md`](./NOTES.md).

---

## Testing

The three API tests required by the brief, run end-to-end against Postgres:

```bash
cd api
pnpm test        # needs a running Postgres (DATABASE_URL)
```

[`api/test/ingest-tenant.e2e-spec.ts`](./api/test/ingest-tenant.e2e-spec.ts):
1. **Bad signature** → `401`.
2. **Duplicate event id** → exactly **one** work item (idempotency).
3. **Cross-tenant denial** → a non-member (and unknown slug) gets `404`, the member gets `200` (no leak).

The suite creates and tears down its own `e2e-*` fixtures against the dev DB — it never touches seed data.

---

## Environments

The API loads `api/.env.<NODE_ENV>`, defaulting to **development**:

| File | Command | Contents |
| --- | --- | --- |
| `.env.development` | `pnpm start:dev` (default) | local DB, dev JWT secrets |
| `.env.staging` | `pnpm start:staging` | placeholder host/user/password — fill from your secret store |
| `.env.production` | `NODE_ENV=production pnpm start:prod` | placeholder host/user/password — fill from your secret store |

Real `.env.*` files are git-ignored; copy [`api/.env.example`](./api/.env.example) to create them. Loading
is done in [`api/src/load-env.ts`](./api/src/load-env.ts) (imported first in `main.ts`) so env vars exist
before any module reads `process.env`; the Prisma CLI reads the same file via
[`api/prisma.config.ts`](./api/prisma.config.ts).

Key knobs: `JWT_ACCESS_TOKEN_EXPIRATION_TIME=5m`, `JWT_REFRESH_TOKEN_EXPIRATION_TIME=7d`,
`WEBHOOK_TOLERANCE_SECONDS=300`, `WEBHOOK_MAX_BODY_BYTES=65536`, `WORK_ITEM_MAX_ATTEMPTS=3`,
`SWAGGER_USER` / `SWAGGER_PASSWORD`.

---

## Prisma client (`prisma-client` generator)

[`api/prisma/schema.prisma`](./api/prisma/schema.prisma) uses the modern generator:

```prisma
generator client {
  provider     = "prisma-client"   // next-gen generator (replaces the legacy prisma-client-js)
  output       = "./generated"     // → api/prisma/generated (git-ignored; regenerate on install)
  moduleFormat = "cjs"             // emit CommonJS to match the NestJS build
}
```

- **`output = "./generated"`** — the client is generated **into the repo** (`api/prisma/generated`) and
  imported directly (`import { PrismaClient } from 'prisma/generated/client'`). It’s git-ignored, so
  **re-run `pnpm prisma:generate` after each install**.
- **`moduleFormat = "cjs"`** — CommonJS output (the Nest build is CJS).
- Because generated code lives outside `src/`, `nest build` emits to `dist/src/main.js` — hence
  `"start": "node dist/src/main.js"`.
- Prisma 7 connects via a **driver adapter**: [`api/src/prisma/prisma.service.ts`](./api/src/prisma/prisma.service.ts)
  passes `new PrismaPg({ connectionString })`, and the datasource URL lives in `prisma.config.ts`.

---

## Project layout

```
.
├─ api/                          NestJS API (standalone)
│  ├─ prisma/
│  │  ├─ schema.prisma           data model (RBAC, events, work items, transitions)
│  │  ├─ migrations/             SQL migration history
│  │  ├─ seed.ts                 workspaces, users, roles, credentials, sample events
│  │  └─ generated/              Prisma client (git-ignored)
│  ├─ src/
│  │  ├─ auth/                   JWT guard, permissions guard, workspace guard, decorators
│  │  ├─ webhooks/               ingest: HMAC verify, idempotency, processor
│  │  ├─ workitems/              scoped reads, lifecycle, retry
│  │  ├─ prisma/ · config/ · common/   infra (adapter, config, envelope, redaction, logging)
│  │  └─ load-env.ts · main.ts · app.module.ts
│  ├─ test/                      e2e spec
│  └─ .env.example · .gitignore · .prettierrc · package.json
├─ web/                          Next.js App Router UI (standalone)
│  ├─ app/w/[workspaceSlug]/     workspace shell, events list, detail, retry
│  ├─ lib/                       server-side API client + session
│  └─ .env.example · .gitignore · package.json
├─ scripts/webhook.sh            fake vendor (curl + HMAC)
├─ NOTES.md                      threat model, cache, crash-safety, week-two
└─ README.md
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Module '@prisma/client'/'prisma/generated/client' has no exported member …` | Run `pnpm prisma:generate` in `api/` (install resets the generated client). |
| API can’t connect to Postgres | Check `DATABASE_URL` in `api/.env.development` and that Postgres is running. |
| Web shows 404 for a workspace | Expected if the signed-in user isn’t a member — that’s tenant isolation. |
| `/docs` asks for a password | Basic auth — dev creds `admin` / `atlas_docs_dev` (from `SWAGGER_*`). |
| Ports busy | API 3333 / Web 3000 — stop stragglers: `lsof -ti :3333 :3000 | xargs kill`. |
