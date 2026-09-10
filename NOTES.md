# NOTES — Northline Atlas Dispatch

A trustworthy vertical slice: **signed ingest → persist → tenant-scoped ops UI → retry**.
One production-shaped path, built to be correct rather than broad.

---

## What's real vs. mocked

| Area | Status |
| --- | --- |
| HMAC-signed ingest, freshness window, size limit, idempotency | **Real** |
| Work-item lifecycle `pending → done \| failed → dead`, bounded retries | **Real** |
| Tenant isolation (every read scoped by membership; no existence leak) | **Real** |
| Ops UI: list + status filter (URL), detail + history, retry + cache invalidation | **Real** |
| Auth: JWT access token + rotating refresh cookie, bcrypt passwords | **Real** (ported from the shared NestJS template) |
| RBAC: roles → permissions, `@Permissions()` + global `PermissionsGuard` (retry gated on `workitem:retry`) | **Real** |
| Vendors | **Mocked** — `scripts/webhook.sh` (curl + HMAC). No real Stripe/shipping. |
| Handler side-effects | **Simulated** — deterministic `simulate` field drives success/failure so the retry path is demoable. |

**Delivery guarantee: at-least-once.** Vendors retry; we dedupe on `(workspace, vendor, vendorEventId)`.
We do **not** claim exactly-once — the handler is not idempotent-by-construction and there is no outbox
(see week-two). We guarantee *one work item per event id*, not *one side-effect per event*.

---

## Signature scheme (documented)

```
Header  X-Webhook-Key: <keyId>
Header  X-Signature:   t=<unixSeconds>,v1=<hexHmacSha256>

signedString = `${t}.${rawBody}`         # rawBody = exact received bytes
v1           = HMAC_SHA256(secret, signedString)   # lowercase hex
```

- The **timestamp is inside the signed string**, so an attacker can't take an old body and staple a
  fresh `t` without the secret.
- Verified against the **raw bytes** (captured in `main.ts` before JSON parsing) — re-serializing JSON
  would change bytes and break the signature.
- Comparison is constant-time (`crypto.timingSafeEqual`).
- **Tenant is derived from the key, never the body.** `keyId → VendorCredential → workspace`. A payload
  claiming `"workspace": "acme"` is ignored; only the credential decides the tenant.

Rejections: missing key / malformed sig → 401 · bad signature → 401 · stale (`|now − t| > 300s`) → 401 ·
oversized (> 64 KiB) → 413 (Express body limit) · missing `id` → 422 · vendor≠credential vendor → 401.

---

## Threat model (short)

**Assets:** tenant event data, work-item state, signing secrets.
**Trust boundary:** the public `POST /webhooks/:vendor` endpoint and the ops UI session.

| Threat | Mitigation |
| --- | --- |
| Forged / spoofed webhook | HMAC-SHA256 over `t.rawBody` with a per-endpoint secret; unsigned/bad → 401. |
| Replay of a captured request | Signed timestamp + 300s tolerance window bounds the replay window; idempotency makes an in-window replay a no-op (one work item). |
| Body tampering | Signature is over exact raw bytes; any change → mismatch. |
| Tenant spoofing via payload | Workspace comes from the credential, not the body. |
| Cross-tenant read (IDOR) | Every query filtered by `workspaceId` resolved from the caller's membership. Non-member **and** unknown slug both return **404** — existence never leaks. Guessing an id in another tenant → 404. |
| Unauthenticated access | Global `AuthGuard` verifies a Bearer JWT on every route except `@Public()` ones (login/webhooks/health/dev). Missing/expired/tampered token → 401. |
| Privilege escalation (viewer performs a write) | Global `PermissionsGuard` enforces `@Permissions()`; retry requires `workitem:retry`. A viewer → 403, at the API (the UI lock is defence-in-depth, not the control). |
| Stolen access token | Short-lived access token (5m) + httpOnly rotating refresh cookie; logout revokes the stored refresh token. |
| User enumeration on login | Uniform "invalid credentials" whether the email or the password was wrong. |
| Oversized-body DoS | Hard 64 KiB body cap at the parser (413) before any work. |
| Secret leakage in logs/UI | Logs carry only `tenantId, vendor, eventId, keyId, outcome` — never secrets or full payloads. Detail view redacts secret-looking keys (`secret/token/password/authorization/signature/…`). |
| Timing side-channel on signature | Constant-time compare. |

**Performance:** guards do **zero DB queries per request** — the access token carries both permissions
and membership claims (`{workspaceId, slug, name, role}[]`), so `AuthGuard`/`PermissionsGuard`/
`WorkspaceGuard` all read from the decoded JWT. The cost is a small staleness window: membership/role
changes apply on the next token mint (login or `/api/auth/refresh`); with a 5-minute access TTL that
window is bounded.

**Known gaps (out of scope for the time box):** no per-tenant rate limit (a brief Stretch item); vendor
secrets and refresh tokens are stored in plaintext in the DB.

---

## Cache & invalidation (how the list stays honest)

Two different mutation sources, two mechanisms — both explainable:

1. **Operator retry (originates in the app).** The retry runs as a **server action** → API `POST /retry`
   → `revalidatePath('/w/[slug]/events')` **and** the detail path. The changed status is visible
   immediately; the client also calls `router.refresh()` so the current view re-renders without a manual
   reload.
2. **New webhook (originates outside Next).** Next can't be told by an external vendor, so list/detail
   reads are `cache: 'no-store'` / `dynamic = 'force-dynamic'` — **always server-rendered fresh**. A new
   event therefore appears on the next navigation or reload. No stale tenant data is ever cached.

Why not tag-based ISR for reads? `revalidateTag` is great for app-initiated writes but can't be triggered
by an external webhook without a push channel, so time-based/`no-store` freshness is the honest default
here. A production build would add an SSE/websocket "new event" nudge (or short-TTL tag revalidation) so
open tabs update without a reload — see week-two.

**No cross-tenant bundling:** all reads are server-side and scoped by the session; the client bundle
never receives another tenant's records. Two tabs (Alice/acme, Bob/northline-shop) stay isolated because
each request is scoped by its own cookie → membership.

---

## Crash mid-handler — what happens?

Ingest is ordered so a crash is always **recoverable, never lost or double-charged at the persistence layer**:

1. **Verify signature** (no writes).
2. **Persist `Event` + `WorkItem(pending)` + first transition in one transaction**, then commit.
3. **Only then run the handler loop**, each attempt persisting its `(status, transition)` in its own transaction.

Crash points:
- **Before step 2 commits** → nothing persisted. Vendor retries (at-least-once) → clean create.
- **After step 2, before/within step 3** → the event is durable; the work item is left `pending` or
  `failed`. It is **not silently done**. An operator (or a future reaper) retries it. If the vendor also
  retries the same `id`, idempotency returns the existing work item — no duplicate.
- The handler is simulated and side-effect-free here, so a mid-handler crash can't half-commit an external
  effect. With a *real* non-idempotent handler this is exactly where you'd need the **outbox + idempotency
  keys** (week-two) to avoid double side-effects.

Processing is synchronous within the request for this slice: deterministic and easy to reason about. The
tradeoff (a slow/failing handler ties up the request; retries aren't durable across a crash) is precisely
what the outbox/worker in week-two fixes.

---

## Data model (one event → one work item)

`Workspace ← Membership → User` · `VendorCredential(keyId, secret) → Workspace` ·
`Event —1:1→ WorkItem —1:N→ StatusTransition`.
Idempotency = unique `(workspaceId, vendor, vendorEventId)` on `Event`; `WorkItem.eventId` is unique.
Bounded retry = `attempts` vs `maxAttempts`; operator retry extends the budget and re-runs the loop.

---

## Week-two list (what I'd build next, in order)

**Where the brief's four Stretch items stand:** *loading UI that doesn't flash the wrong workspace name*
is **done** (the workspace shell resolves the tenant server-side before render — see Cache section).
The other three — **outbox**, **replay vs. retry**, **per-tenant rate limit** — are planned below.

1. **Transactional outbox + message broker.** Today the handler runs synchronously inside the ingest
   request. Next: write an outbox row in the same transaction as the event, a relay publishes it to a
   **message broker (AWS SQS / RabbitMQ)**, and a separate consumer does the real work (e.g. calling the
   shipping vendor) with backoff retries and a **dead-letter queue**. This guarantees a shipment is never
   lost if the process crashes, decouples ingest latency from downstream processing, and is the foundation
   for exactly-once-ish side-effects (with idempotency keys downstream). *Stretch.*
2. **Replay vs. retry distinction.** *Retry* is already built: it re-attempts the **same** work item and
   accumulates its attempt history on that record. *Replay* is the counterpart — take the stored raw event
   and re-emit it as a **brand-new** work item (fresh id), reprocessing from scratch while keeping the
   original for audit. Use case: after fixing downstream code, replay past events without mutating their
   history. Same source event, different button, different semantics. *Stretch.*
3. **Per-tenant rate limit** on ingest (token bucket keyed by workspace) so one noisy vendor can't starve
   another tenant. *Stretch.*
4. **Live list updates** via SSE/websocket (or short-TTL tag revalidation) so open tabs reflect new
   webhooks without a manual reload. *(Beyond the brief — the loading UI already avoids the wrong-workspace flash.)*
