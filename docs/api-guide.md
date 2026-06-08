# Landlord CRM API — Integration Guide

> **Audience:** developers building a client (web, mobile, or server-to-server) against the backend.
> **Scope:** documents the full contract as built through Phase 11 — auth, portfolio, tenancies, the rent subledger, maintenance/interactions, file attachments, inspections, public tenant intake, and tamper-evident evidence exports.
> **Source of truth:** the live OpenAPI 3.1 spec at `GET /openapi.json` is canonical for exact field names, types, and enums. This guide explains the shape and the conventions; when in doubt, generate types from the spec.

---

## Table of contents

1. [Base URL & versioning](#1-base-url--versioning)
2. [Conventions (read this first)](#2-conventions-read-this-first)
3. [Authentication](#3-authentication)
4. [Idempotency, pagination, and errors](#4-idempotency-pagination-and-errors)
5. [Portfolio — properties, areas, units, assets, vendors](#5-portfolio--properties-areas-units-assets-vendors)
6. [People & occupancy — tenants, tenancies, members, leases](#6-people--occupancy--tenants-tenancies-members-leases)
7. [Money — rent subledger](#7-money--rent-subledger)
8. [Maintenance & interactions](#8-maintenance--interactions)
9. [Attachments & file uploads](#9-attachments--file-uploads)
10. [Inspections](#10-inspections)
11. [Public intake (unauthenticated tenant submissions)](#11-public-intake-unauthenticated-tenant-submissions)
12. [Evidence exports](#12-evidence-exports)
13. [Using the generated TypeScript SDK](#13-using-the-generated-typescript-sdk)
14. [End-to-end: the golden path](#14-end-to-end-the-golden-path)
15. [Guarantees you can rely on](#15-guarantees-you-can-rely-on)

---

## 1. Base URL & versioning

```
https://rental-crm-api.onrender.com/v1
```

- All endpoints live under `/v1`. Breaking changes ship as `/v2`; `/v1` is never broken in place.
- `GET /healthz` (no `/v1` prefix) returns `{"status":"ok","capabilities":{"heic_decode":true|false|null}}` and is safe to hit from load balancer health checks. `heic_decode` reflects whether the server's `sharp`/libvips build includes libheif support; `null` means the probe hasn't finished yet (first ~50ms after boot).
- `GET /openapi.json` returns the full OpenAPI 3.1 spec.
- Couple only to this contract. Do **not** reach past it into the underlying database — that coupling forfeits forward-compatibility, and the API enforces invariants (isolation, audit trail, money integrity) that direct DB access bypasses.

---

## 2. Conventions (read this first)

| Concern | Rule |
|---|---|
| **Auth** | `Authorization: Bearer <access_token>`. The token is opaque — obtain it from `/v1/auth/*`, attach it, refresh on `401`. Never parse it or depend on the identity provider behind it. |
| **Account scoping** | Account context is in the **URL path**: `/v1/accounts/{accountId}/...`. There is no account header. The token's user must be a member of `{accountId}`, or you get `404`. |
| **Idempotency** | `Idempotency-Key: <uuid>` is **required on every mutating request** (`POST`, `PATCH`, `DELETE`) under `/v1/accounts/*`. Same key + same body → the original response is replayed. Same key + different body → `409`. Missing key → `400`. Generate a fresh UUID per logical operation; reuse only on network retries. |
| **Pagination** | Cursor-based: `?limit=50&cursor=<opaque>`. Responses include `next_cursor` (`null` at the end). Default limit 50, max 100. There is no offset paging. |
| **Errors** | Always `{ "error": { "code": "...", "message": "...", "details"?: {...} } }` with a standard HTTP status. **Branch on `code`, not `message`** — messages may change within a version; codes won't. |
| **Money** | Integer **minor units** (`*_cents`) plus an explicit `currency` (3-char ISO 4217). Never floating-point. Amounts are strictly positive (exclusive minimum 0). |
| **Timestamps** | Server-set timestamps (`logged_at`, `received_at`, `completed_at`, `generated_at`) are immutable — you never send them. Client-stated times (`occurred_at`, `performed_at`) are yours to set and edit. |
| **Soft deletes** | All domain records have `deleted_at`. List endpoints filter it out by default. A `404` on a resource you expect to exist means "not in this account" or "soft-deleted," never "permanently gone." |
| **Isolation** | Any cross-account or cross-tenancy reference returns `404` — the API never confirms the existence of another account's data. Enforced at the database (row-level security), not just the API layer. |

---

## 3. Authentication

The API fronts its own auth endpoints; you never import a vendor auth SDK. The flow:

1. `POST /v1/auth/signup` or `/v1/auth/login` → get an `access_token` + `refresh_token`.
2. `GET /v1/me` → list the accounts you're a member of; pick an `accountId`.
3. Call account-scoped endpoints with the bearer token and that `accountId` in the path.
4. On `401`, call `/v1/auth/refresh` once and retry; if that fails, send the user back to login.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/auth/signup` | Create a user, an account, and the first membership (`owner`), atomically. Returns tokens + account. |
| `POST` | `/v1/auth/login` | Exchange credentials for tokens. |
| `POST` | `/v1/auth/refresh` | Exchange a refresh token for a fresh access token. |
| `POST` | `/v1/auth/logout` | Revoke the token. `scope` ∈ `global` (default) / `local` / `others`. |
| `GET`  | `/v1/me` | Current user + account memberships with roles. Not account-scoped. |

### Signup request / response

```jsonc
// POST /v1/auth/signup
{
  "email": "landlord@example.com",
  "password": "correct-horse-battery-staple",  // 8–200 chars
  "account_name": "Maple Street Holdings LLC"   // 1–200 chars
}
// 200 →
{
  "user":    { "id": "63b4...", "email": "landlord@example.com" },
  "account": { "id": "8a1b...", "role": "owner" },
  "session": {
    "access_token":  "eyJ...",
    "refresh_token": "v1.M...",
    "token_type":    "Bearer",
    "expires_in":    300,
    "expires_at":    1748000000
  }
}
```

If email confirmation is required the server returns `202` with `{"status":"pending_verification"}` instead of tokens. Watch for this when building the onboarding flow.

### Refresh on 401 (TypeScript)

```ts
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(`https://rental-crm-api.onrender.com${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });

  let res = await doFetch(session.accessToken);
  if (res.status === 401) {
    const r = await fetch("https://rental-crm-api.onrender.com/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!r.ok) throw new Error("re-login required");
    session.accessToken = (await r.json()).session.access_token;
    res = await doFetch(session.accessToken);
  }
  return res;
}
```

---

## 4. Idempotency, pagination, and errors

### Idempotency

Required on every mutating request under `/v1/accounts/*`. Generate a UUID per logical operation; reuse only on network-layer retries of the *exact same* operation.

```ts
const key = crypto.randomUUID();
await authedFetch(`/v1/accounts/${accountId}/properties`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": key,
  },
  body: JSON.stringify({ name: "12 Maple St", address: "12 Maple St, Springfield" }),
});
// A retry with the SAME key + body replays the original response — no duplicate row.
// A retry with the SAME key + DIFFERENT body → 409 idempotency_key_reuse.
```

Keys are stored 24 hours for in-flight or completed requests; in-flight keys older than 7 days are never freed (safety invariant: a key that may have committed is never recycled).

### Pagination

```ts
async function* listAll<T>(path: string): AsyncGenerator<T> {
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
    const res = await authedFetch(`${path}?${qs}`);
    const page = await res.json(); // { data: T[], next_cursor: string | null }
    for (const item of page.data) yield item;
    cursor = page.next_cursor;
  } while (cursor !== null);
}
```

### Error shape

```jsonc
{
  "error": {
    "code":    "invalid_status_transition",      // machine-readable; branch on this
    "message": "cannot move a closed request to in_progress",
    "details": { "from": "closed", "to": "in_progress" }  // optional
  }
}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request`, `missing_idempotency_key` | Bad/missing input. `details` contains field-level validation errors. |
| 401 | `unauthenticated` | Missing/expired token — refresh and retry. |
| 403 | `forbidden` | Authenticated but not a member of this account. |
| 404 | `not_found` | Resource absent, soft-deleted, or belongs to another account (no existence oracle). |
| 409 | `conflict`, `idempotency_key_reuse`, `invalid_status_transition`, `duplicate_active_token` | State conflict. |
| 422 | `allocation_exceeds_payment`, `cross_tenancy_allocation`, `currency_mismatch` | Money-integrity rejections. |
| 429 | `rate_limited` | Public intake throttle (per-token or per-IP). |
| 500 | `internal_error`, `database_error` | Server fault. |

> `404` on a resource you expect to exist means "not in this account/tenancy," not necessarily "deleted."

---

## 5. Portfolio — properties, areas, units, assets, vendors

All endpoints under `/v1/accounts/{accountId}/`. Every mutating call requires `Idempotency-Key`.

### Properties

The top-level entities — buildings or parcels you manage.

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/properties` | Paginated list. |
| `POST` | `/properties` | `name` (required, 1–200), `address` (optional object). |
| `GET` | `/properties/{id}` | |
| `PATCH` | `/properties/{id}` | `name`, `address` — all optional, at least one required. |
| `DELETE` | `/properties/{id}` | Soft-delete. |

### Areas

Subdivisions within a property. `kind` is **immutable** after creation.

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/areas` | Supports `?property_id=` filter. |
| `POST` | `/areas` | `property_id` (required), `kind` (required, see below), `name` (required, 1–200). |
| `GET` | `/areas/{id}` | |
| `PATCH` | `/areas/{id}` | `name` only (kind is immutable). |
| `DELETE` | `/areas/{id}` | Soft-delete. |

`kind` values:

| Value | Description |
|---|---|
| `unit` | Rentable unit; required for tenancies, inspections |
| `entrance` | Building entrance |
| `hallway` | Corridor |
| `stairwell` | Stairwell |
| `basement_mechanical` | Mechanical room |
| `laundry` | Shared laundry |
| `parking` | Parking area |
| `roof` | Roof space |
| `exterior_grounds` | Yard, lot |
| `common_other` | Any other shared space |

### Unit details (unit-only extension)

`PUT` behaves as an upsert. `PATCH` semantics apply: explicit `null` clears the field; omitted leaves it unchanged.

| Method | Path | Body |
|---|---|---|
| `PUT` | `/areas/{areaId}/unit-details` | `bedrooms` (integer≥0\|null), `bathrooms` (number≥0\|null), `sqft` (integer≥0\|null) |
| `GET` | `/areas/{areaId}/unit-details` | |

### Assets

Systems or appliances within an area (HVAC, water heater, smoke detectors, etc.).

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/assets` | Supports `?area_id=` filter. |
| `POST` | `/assets` | `area_id` (required), `name` (required), `kind` (required, 1–100), `attributes` (optional object). |
| `GET` | `/assets/{id}` | |
| `PATCH` | `/assets/{id}` | Any subset of `name`, `kind`, `attributes`. |
| `DELETE` | `/assets/{id}` | Soft-delete. |

### Vendors

Contractors, suppliers, and service providers.

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/vendors` | Paginated list. |
| `POST` | `/vendors` | `name` (required), `contact` (optional object), `notes` (optional string). |
| `GET` | `/vendors/{id}` | |
| `PATCH` | `/vendors/{id}` | Any subset of `name`, `contact`, `notes`. |
| `DELETE` | `/vendors/{id}` | Soft-delete. |

---

## 6. People & occupancy — tenants, tenancies, members, leases

### Tenants

The individuals who rent. A tenant record is a person, independent of any specific tenancy.

| Method | Path | Body |
|---|---|---|
| `GET` | `/tenants` | |
| `POST` | `/tenants` | `full_name` (required), `emails[]` (optional), `phones[]` (optional), `notes` (optional). |
| `GET` | `/tenants/{id}` | |
| `PATCH` | `/tenants/{id}` | Any subset. |
| `DELETE` | `/tenants/{id}` | Soft-delete. |

### Tenancies

An **occupancy period** — who occupied which unit, when. This is the operational spine that charges, payments, maintenance, and interactions attach to. `area_id` is **immutable** after creation; the area must have `kind=unit`.

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/tenancies` | Supports `?area_id=`, `?status=` filters. |
| `POST` | `/tenancies` | `area_id` (required), `start_date` (required, YYYY-MM-DD), `end_date` (optional), `status` (required, see below). |
| `GET` | `/tenancies/{id}` | |
| `PATCH` | `/tenancies/{id}` | `end_date`, `status`. |
| `DELETE` | `/tenancies/{id}` | Soft-delete. |

`status` values: `upcoming` → `active` → `holdover` / `ended`.

### Tenancy members

People associated with an occupancy and their roles.

| Method | Path | Body |
|---|---|---|
| `GET` | `/tenancies/{tenancyId}/members` | |
| `POST` | `/tenancies/{tenancyId}/members` | `tenant_id` (required), `role` ∈ `primary`/`occupant`/`guarantor`. |
| `PATCH` | `/tenancies/{tenancyId}/members/{id}` | `role`. |
| `DELETE` | `/tenancies/{tenancyId}/members/{id}` | Soft-delete. |

### Leases

Contract **documents** attached to a tenancy. A tenancy never *requires* a lease (handshake/month-to-month tenancies are valid). One tenancy can have multiple leases (renewals, addenda).

> **Modeling note:** a *tenancy* is the fact of occupancy; a *lease* is a document. Timeline and balance data live on the tenancy, not the lease.

| Method | Path | Body |
|---|---|---|
| `GET` | `/leases` | Supports `?tenancy_id=`, `?status=` filters. |
| `POST` | `/leases` | `tenancy_id`, `term_start`, `term_end`\|null, `rent_amount_cents` (≥0), `rent_currency`, `deposit_amount_cents` (≥0, optional), `deposit_currency` (optional), `document` (optional object), `status` ∈ `draft`/`active`/`expired`/`superseded`. |
| `GET` | `/leases/{id}` | |
| `PATCH` | `/leases/{id}` | Any subset. |
| `DELETE` | `/leases/{id}` | Soft-delete. |

---

## 7. Money — rent subledger

What's **owed** (`charges`) and what's **received** (`payments`) are separate. The balance is **derived** from allocations. A partial payment is just an allocation smaller than the charge.

### Rent schedules

Define a recurring charge. You cannot PATCH or DELETE a schedule — to change rent, end the current schedule and start a new one. The cron job reads active schedules and generates the monthly charge rows automatically.

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/rent-schedules` | Supports `?tenancy_id=` filter. |
| `POST` | `/rent-schedules` | `tenancy_id` (required), `kind` (required, 1–50), `amount_cents` (≥0), `currency`, `due_day` (1–28), `start_date`, `end_date`\|null. |
| `GET` | `/rent-schedules/{id}` | |
| `POST` | `/rent-schedules/{id}/end` | `end_date` (required). Sets `end_date`; the schedule stops generating charges after that date. |

> The server-side cron calls `generate_rent_charges()` daily. If you prefer to create charge rows yourself, do so via `POST /charges`. A schedule-generated and a manually created charge are identical — both are plain `Charge` rows.

### Charges

Amounts owed. No mutation — corrections use `void` plus a new reversing entry (e.g., charge an `nsf_fee` after a bounced check, don't edit the original payment).

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/charges` | Supports `?tenancy_id=` filter. |
| `POST` | `/charges` | `tenancy_id`, `type`, `amount_cents` (>0), `currency`, `due_date`, `period_start`\|null, `period_end`\|null, `description`\|null. |
| `GET` | `/charges/{id}` | |
| `POST` | `/charges/{id}/void` | `void_reason` (required, 1–500). Sets `voided_at`; excluded from totals but present in the ledger with `voided_at` visible. |

`type` values: `rent` / `late_fee` / `deposit` / `utility` / `parking` / `repair_chargeback` / `nsf_fee` / `other`.

### Payments

Money received. Inline allocations are atomic: if any allocation fails (cross-tenancy, over-allocation, currency mismatch) the entire call rolls back — no orphan payment row.

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/payments` | Supports `?tenancy_id=` filter. |
| `POST` | `/payments` | `tenancy_id`, `amount_cents` (>0), `currency`, `received_at`, `method`, `reference`\|null, `payer_tenant_id`\|null, `notes`\|null, `allocations[]` (optional). |
| `GET` | `/payments/{id}` | Returns `{payment, allocations[]}`. |
| `POST` | `/payments/{id}/void` | `void_reason` (required). |
| `POST` | `/payments/{id}/allocations` | `{charge_id, amount_cents}[]` — apply more of an existing payment to charges after the fact. |

`method` values: `cash` / `check` / `ach` / `card` / `zelle_venmo` / `money_order` / `other`.

### Ledger (read-only)

The derived financial view of a tenancy. Balances are computed from charges minus allocations — never stored.

```bash
GET /v1/accounts/{accountId}/tenancies/{tenancyId}/ledger
```

```jsonc
{
  "tenancy_id": "t_1",
  "currency": "USD",
  "entries": [
    {
      "kind": "charge",
      "id": "c_1",
      "occurred_at": "2026-06-01",
      "type": "rent",
      "amount_cents": 120000,
      "derived_balance_cents": 50000,  // charge minus all non-voided allocations
      "is_deposit": false,
      "voided_at": null
    },
    {
      "kind": "payment",
      "id": "pay_1",
      "occurred_at": "2026-06-01",
      "amount_cents": 70000,
      "method": "check",
      "reference": null,
      "voided_at": null,
      "allocations": [{ "charge_id": "c_1", "amount_cents": 70000 }]
    }
  ],
  "totals": {
    "rent_charges_cents": 120000,
    "rent_payments_cents": 70000,
    "rent_balance_cents": 50000,       // still owed on rent
    "deposit_charges_cents": 0,
    "deposit_payments_cents": 0,
    "deposit_balance_cents": 0,
    "total_received_cents": 70000,
    "total_allocated_cents": 70000,
    "unapplied_credit_cents": 0        // received but not yet allocated to any charge
  }
}
```

Voided entries appear in `entries` with `voided_at` set but are excluded from `totals`.

### Money example (curl)

```bash
# 1. Record rent owed ($1,200)
curl -sX POST https://rental-crm-api.onrender.com/v1/accounts/8a1b.../charges \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "tenancy_id": "t_1", "type": "rent",
    "amount_cents": 120000, "currency": "USD",
    "due_date": "2026-06-01", "period_start": "2026-06-01", "period_end": "2026-06-30"
  }'

# 2. Record a partial payment of $700 inline-allocated to that charge
curl -sX POST https://rental-crm-api.onrender.com/v1/accounts/8a1b.../payments \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "tenancy_id": "t_1",
    "amount_cents": 70000, "currency": "USD",
    "received_at": "2026-06-03T10:00:00Z",
    "method": "check",
    "allocations": [{ "charge_id": "c_1", "amount_cents": 70000 }]
  }'

# 3. Read the derived balance
curl -s https://rental-crm-api.onrender.com/v1/accounts/8a1b.../tenancies/t_1/ledger \
  -H 'Authorization: Bearer eyJ...'
# totals.rent_balance_cents === 50000
```

---

## 8. Maintenance & interactions

### Maintenance requests

Repair requests. Server enforces the status state machine — invalid transitions return `409 invalid_status_transition`.

```
open → triaged | in_progress | closed
triaged → in_progress | closed
in_progress → resolved | closed
resolved → closed
closed → (terminal)
```

| Method | Path | Body |
|---|---|---|
| `GET` | `/maintenance-requests` | |
| `POST` | `/maintenance-requests` | `area_id`, `title` (1–200), `severity` (required), `description` (optional, max 5000), `asset_id`\|null. |
| `GET` | `/maintenance-requests/{id}` | |
| `PATCH` | `/maintenance-requests/{id}` | `description`\|null, `severity`, `status`, `asset_id`\|null. |

`severity` values: `emergency` / `urgent` / `routine`.

### Interactions

The contact log. Records any communication on any channel, including offline contacts the landlord logs after the fact.

`occurred_at` — when the interaction happened (client-set, editable).
`logged_at` — when it was recorded in the system (server-set, immutable). The gap between them is part of the audit record.

| Method | Path | Body |
|---|---|---|
| `GET` | `/interactions` | |
| `POST` | `/interactions` | `channel`, `direction`, `party_type` (required), `occurred_at` (required), `body` (optional, max 20000), `tenancy_id`\|null, `maintenance_request_id`\|null, `area_id`\|null, `vendor_id`\|null, `party_id`\|null, `party_label`\|null. |
| `GET` | `/interactions/{id}` | |

`channel` values: `in_person` / `phone` / `voicemail` / `sms` / `email` / `letter` / `in_app`.
`direction` values: `inbound` / `outbound`.
`party_type` values: `tenant` / `vendor` / `inspector` / `other`.

```bash
curl -sX POST https://rental-crm-api.onrender.com/v1/accounts/8a1b.../interactions \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "tenancy_id": "t_1",
    "channel": "in_person",
    "direction": "inbound",
    "party_type": "tenant",
    "occurred_at": "2026-06-05T18:30:00Z",
    "body": "Tenant flagged a dripping kitchen faucet at the door."
  }'
```

### Intake tokens

Magic links for unauthenticated tenant submissions. See §11 for the public intake endpoint.

| Method | Path | Body / Notes |
|---|---|---|
| `POST` | `/intake-tokens` | `tenancy_id` (required). Returns the secret **once** — it is not recoverable. |
| `GET` | `/intake-tokens` | Returns token rows (no secrets). |
| `POST` | `/intake-tokens/{id}/revoke` | Revokes the token immediately. Auto-revoked when the tenancy ends. |

```jsonc
// POST /intake-tokens → 201
{
  "id":          "tok_abc...",     // public row ID; safe to log
  "secret":      "y3Jq...",       // shown ONCE; treat like a password
  "tenancy_id":  "t_1",
  "property_id": "p_1",
  "account_id":  "8a1b...",
  "created_at":  "2026-06-01T00:00:00Z"
}
```

---

## 9. Attachments & file uploads

Files tied to any entity — maintenance requests, inspection items, inspections, evidence exports.

### Upload

`POST /v1/accounts/{accountId}/attachments` — **multipart/form-data**

| Field | Type | Required | Notes |
|---|---|---|---|
| `entity_type` | string | yes | `maintenance_requests` / `inspections` / `inspection_items` / `evidence_export` / `inspection_report` |
| `entity_id` | uuid | yes | ID of the entity |
| `file` | binary | yes | Max 50 MB. Accepted MIME types: `image/jpeg`, `image/png`, `image/heic`, `image/heif`, `application/pdf` |

**HEIC handling:** if the file is HEIC/HEIF and the server has libheif available (`/healthz` → `capabilities.heic_decode: true`), the API transcodes the original to a JPEG derivative and creates two attachment rows atomically. The original HEIC row has `derived_from: null`; the JPEG row has `derived_from: <heic_id>`. Both rows share the same `entity_type`/`entity_id`. If libheif is unavailable, the HEIC lands as-is — one row, no derivative.

```jsonc
// Response: 201
{
  "attachment": {
    "id":           "att_1",
    "account_id":   "8a1b...",
    "entity_type":  "maintenance_requests",
    "entity_id":    "mr_1",
    "storage_path": "accounts/8a1b.../maintenance_requests/mr_1/att_1.heic",
    "content_hash": "sha256:abc...",    // server-computed SHA256; verify for integrity
    "mime_type":    "image/heic",
    "size_bytes":   2048576,
    "uploaded_by":  "usr_1",
    "derived_from": null,
    "received_at":  "2026-06-05T10:00:00Z",
    "created_at":   "2026-06-05T10:00:00Z"
  },
  "derivative": {
    // present only when original was HEIC and server transcoded it
    "id":           "att_2",
    "mime_type":    "image/jpeg",
    "derived_from": "att_1",
    // ...same shape as above
  }
}
```

### List and retrieve

| Method | Path | Notes |
|---|---|---|
| `GET` | `/attachments` | Supports `?entity_type=` and `?entity_id=` filters. Returns metadata only. |
| `GET` | `/attachments/{id}` | Metadata only. |

### Download

```
GET /v1/accounts/{accountId}/attachments/{id}/download
```

Returns the raw file bytes with hardened response headers:

```
Content-Type: <server-computed at upload, not client-tamperable>
Content-Disposition: attachment; filename="..."
X-Content-Sha256: <sha256 of bytes>   ← verify against attachment.content_hash
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
Cache-Control: private, no-store
```

Always verify `X-Content-Sha256` against the `content_hash` you stored — this detects storage corruption or tampering.

### Delete

`DELETE /v1/accounts/{accountId}/attachments/{id}` — soft-delete. Requires `Idempotency-Key`. Returns `204`.

---

## 10. Inspections

Walk-through inspections with a checklist of items, optional template, and a deterministic PDF report on completion.

### Inspection templates

Reusable schemas for what to check during an inspection.

| Method | Path | Body |
|---|---|---|
| `GET` | `/inspection-templates` | |
| `POST` | `/inspection-templates` | `name` (required, 1–200), `schema` (optional object — your question/field structure). |
| `GET` | `/inspection-templates/{id}` | |
| `PATCH` | `/inspection-templates/{id}` | `name`, `schema`. |
| `DELETE` | `/inspection-templates/{id}` | Soft-delete. |

### Inspections

An instance of an inspection against a specific area.

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/inspections` | Supports `?area_id=` filter. |
| `POST` | `/inspections` | `area_id` (required), `template_id`\|null, `performed_at`\|null (ISO8601), `notes`\|null. |
| `GET` | `/inspections/{id}` | |
| `PATCH` | `/inspections/{id}` | `template_id`\|null, `performed_at`\|null, `notes`\|null. Returns `409` if already completed. |
| `POST` | `/inspections/{id}/complete` | No body. Locks the inspection and renders the PDF. |

**Completion is irreversible.** Once `completed_at` is set, PATCH returns `409 conflict` and items can no longer be added or changed. The complete endpoint is idempotent — calling it twice returns the same result.

`POST /inspections/{id}/complete` response:

```jsonc
{
  "inspection": {
    "id":           "ins_1",
    "area_id":      "a_1",
    "performed_by": "usr_1",
    "performed_at": "2026-06-05T14:00:00Z",
    "completed_at": "2026-06-05T14:30:00Z",   // set by this call
    "notes":        "Move-in condition."
  },
  "report": {
    "attachment_id": "att_report_1",
    "content_hash":  "sha256:def...",
    "size_bytes":    184320
  }
}
```

Download the PDF: `GET /v1/accounts/{accountId}/attachments/att_report_1/download`.

### Inspection items

Checklist items within an inspection. Blocked with `409` if the parent inspection is completed.

| Method | Path | Body |
|---|---|---|
| `GET` | `/inspections/{inspectionId}/items` | |
| `POST` | `/inspections/{inspectionId}/items` | `label` (required, 1–200), `condition` (optional, max 200), `notes` (optional, max 5000). |
| `PATCH` | `/inspections/{inspectionId}/items/{id}` | `label`, `condition`, `notes`. |
| `DELETE` | `/inspections/{inspectionId}/items/{id}` | Soft-delete. Blocked if inspection is completed. |

### Typical inspection flow

```ts
// 1. Create inspection
const ins = await post(`/v1/accounts/${accountId}/inspections`, {
  area_id: unitId,
  performed_at: new Date().toISOString(),
  notes: "Move-in walk-through",
});

// 2. Add checklist items
await post(`/v1/accounts/${accountId}/inspections/${ins.id}/items`, {
  label: "Kitchen — sink", condition: "Good", notes: "Minor scratch on left basin"
});
await post(`/v1/accounts/${accountId}/inspections/${ins.id}/items`, {
  label: "Bedroom — carpet", condition: "Fair", notes: "Stain in NW corner"
});

// 3. Attach photos (one per item, or to the inspection itself)
const form = new FormData();
form.append("entity_type", "inspection_items");
form.append("entity_id", item.id);
form.append("file", photoBlob, "photo.jpg");
await authedFetch(`/v1/accounts/${accountId}/attachments`, { method: "POST", body: form });

// 4. Lock and generate the PDF report
const result = await post(`/v1/accounts/${accountId}/inspections/${ins.id}/complete`, {});
// result.report.attachment_id → fetch the PDF
```

---

## 11. Public intake (unauthenticated tenant submissions)

A landlord mints a per-tenancy token; tenants submit maintenance requests through it — no account, no login. The link is create-only, rate-limited, and auto-revoked when the tenancy ends.

### Submit a maintenance request

```
POST /v1/intake/{secret}
```

Accepts `application/json` (text-only) or `multipart/form-data` (with optional file).

| Field | Type | Required | Notes |
|---|---|---|---|
| `area_id` | uuid | yes | Must belong to the token's property — scoping is derived from the token, not user input. |
| `title` | string | yes | 1–200 chars. |
| `severity` | string | yes | `emergency` / `urgent` / `routine` |
| `description` | string | no | Max 5000 chars. |
| `occurred_at` | ISO8601 | no | When the issue was noticed; defaults to server time. |
| `file` | binary | no | Multipart only. HEIC or JPEG, max 50 MB. |

```bash
# Text-only (JSON)
curl -sX POST https://rental-crm-api.onrender.com/v1/intake/y3Jq... \
  -H 'Content-Type: application/json' \
  -d '{
    "area_id":     "a_unit_2b",
    "title":       "No hot water",
    "severity":    "urgent",
    "description": "Hot water has been out since last night."
  }'

# With a photo (multipart)
curl -sX POST https://rental-crm-api.onrender.com/v1/intake/y3Jq... \
  -F 'area_id=a_unit_2b' \
  -F 'title=Water leak under kitchen sink' \
  -F 'severity=urgent' \
  -F "file=@/path/to/photo.jpg;type=image/jpeg"
```

```jsonc
// 201 response
{
  "maintenance_request_id": "mr_new",
  "interaction_id":         "int_new",
  "attachment_id":          "att_1",    // null if no file
  "derivative_id":          "att_2",    // null if not HEIC or libheif unavailable
  "deduped_onto_existing":  false       // true if merged into an open request with same area+title
}
```

**Deduplication:** if an open request already exists for the same `area_id` + `title`, the submission merges into it (a new interaction + photo are added; a new request is *not* created). `deduped_onto_existing: true` signals this.

**Rate limits:**
- Per-token: 20 uses per 10-minute sliding window.
- Per-IP: 50 requests per 10-minute sliding window.
- Returns `429` when either limit is exceeded.

**Security notes:**
- A forged, expired, or revoked token returns `404` — no existence oracle.
- The `area_id` must belong to the token's property; cross-property references return `404`.
- The file is stored in Supabase Storage before the database transaction. Orphan blobs from failed transactions are pruned by the server-side janitor cron.
- Audit attribution for all rows created via intake uses `actor = "tenant:<token_id>"`.

---

## 12. Evidence exports

A tamper-evident PDF bundle of everything in the system about a tenancy or area — for use in housing court, insurance claims, or dispute resolution.

### Create an export

```
POST /v1/accounts/{accountId}/evidence-exports
Content-Type: application/json
Idempotency-Key: <uuid>
```

At least one of `tenancy_id` or `area_id` is required. Blank-scope exports are rejected.

| Field | Type | Notes |
|---|---|---|
| `tenancy_id` | uuid | Export all evidence for this tenancy. Works for ended/soft-deleted tenancies. |
| `area_id` | uuid | Export all evidence for this area (all tenancies in it). |
| `from_date` | date | Optional. Narrow the date range. |
| `to_date` | date | Optional. |

```jsonc
// 201 response
{
  "id":             "exp_1",
  "attachment_id":  "att_pdf_1",   // download via GET /attachments/att_pdf_1/download
  "content_hash":   "sha256:xyz...",
  "size_bytes":     524288,
  "generated_at":   "2026-06-08T03:00:00Z",
  "chain_verified": true,
  "chain_message":  "Audit chain verified intact as of 2026-06-08T03:00:00Z"
}
```

**What the PDF contains:**
- Tenancy overview and lease(s)
- Full rent ledger (charges, payments, allocations, voids)
- All interactions (phone calls, emails, in-person notes)
- All maintenance requests with status history
- All inspections with items and attached photos
- Chain-of-custody for each photo (upload timestamp, content hash, actor)
- Audit chain verification result (tamper banner if chain is broken)

**`chain_verified`:** the API runs a recursive hash-chain check over all audit events for the tenancy at export time. `true` means no tampering was detected. `false` embeds a tamper-alert banner in the PDF.

### Retrieve and download

| Method | Path | Notes |
|---|---|---|
| `GET` | `/evidence-exports` | List all exports for this account. |
| `GET` | `/evidence-exports/{id}` | Single export row with `chain_verified`, `chain_message`, etc. |
| `GET` | `/evidence-exports/{id}/download` | Raw PDF bytes with same hardened headers as attachment downloads. |

```bash
# Create and immediately download
EXPORT=$(curl -sX POST https://rental-crm-api.onrender.com/v1/accounts/8a1b.../evidence-exports \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"tenancy_id": "t_1"}')

ATTACHMENT_ID=$(echo $EXPORT | python3 -c "import sys,json; print(json.load(sys.stdin)['attachment_id'])")

curl -s https://rental-crm-api.onrender.com/v1/accounts/8a1b.../attachments/$ATTACHMENT_ID/download \
  -H 'Authorization: Bearer eyJ...' \
  -o evidence.pdf
```

---

## 13. Using the generated TypeScript SDK

Generate a typed client from the live spec rather than hand-writing types.

```bash
# Generate types
npx openapi-typescript https://rental-crm-api.onrender.com/openapi.json -o ./src/api/schema.d.ts
```

```ts
import createClient from "openapi-fetch";
import type { paths } from "./api/schema";

const api = createClient<paths>({ baseUrl: "https://rental-crm-api.onrender.com" });

// Middleware: attach bearer token + idempotency key on every request
api.use({
  async onRequest({ request }) {
    request.headers.set("Authorization", `Bearer ${session.accessToken}`);
    if (request.method !== "GET") {
      request.headers.set("Idempotency-Key", crypto.randomUUID());
    }
    return request;
  },
});

// Fully typed — path params, query, body, and response checked against the spec
const { data, error } = await api.GET(
  "/v1/accounts/{accountId}/tenancies/{tenancyId}/ledger",
  { params: { path: { accountId, tenancyId } } }
);

if (error) {
  switch (error.error.code) {
    case "not_found":      /* handle */ break;
    case "unauthenticated": /* refresh */ break;
    default: throw error;
  }
} else {
  console.log(data.totals.rent_balance_cents);
}
```

For non-TypeScript clients, generate from `GET /openapi.json` using your language's OpenAPI generator.

---

## 14. End-to-end: the golden path

A minimal integration covering the full lifecycle: signup → unit → tenant → rent → maintenance → inspection → evidence export.

```ts
// 1. Sign up → tokens + account
const signup = await post("/v1/auth/signup", {
  email, password, account_name: "Maple St LLC"
});
const { accountId } = signup.account.id;

// 2. Portfolio: property → unit → unit details
const property = await post(`/v1/accounts/${accountId}/properties`,
  { name: "12 Maple St", address: "12 Maple St, Springfield IL" });

const unit = await post(`/v1/accounts/${accountId}/areas`,
  { property_id: property.id, kind: "unit", name: "Apt 2B" });

await put(`/v1/accounts/${accountId}/areas/${unit.id}/unit-details`,
  { bedrooms: 2, bathrooms: 1, sqft: 850 });

// 3. Tenant → tenancy → member
const tenant = await post(`/v1/accounts/${accountId}/tenants`,
  { full_name: "Dana Lee", emails: ["dana@example.com"] });

const tenancy = await post(`/v1/accounts/${accountId}/tenancies`,
  { area_id: unit.id, start_date: "2026-06-01", status: "active" });

await post(`/v1/accounts/${accountId}/tenancies/${tenancy.id}/members`,
  { tenant_id: tenant.id, role: "primary" });

// 4. Rent schedule (cron generates charges automatically)
await post(`/v1/accounts/${accountId}/rent-schedules`, {
  tenancy_id: tenancy.id, kind: "rent",
  amount_cents: 120000, currency: "USD",
  due_day: 1, start_date: "2026-06-01"
});

// 5. Record a charge and partial payment manually (if not using cron)
const charge = await post(`/v1/accounts/${accountId}/charges`, {
  tenancy_id: tenancy.id, type: "rent",
  amount_cents: 120000, currency: "USD",
  due_date: "2026-06-01"
});

await post(`/v1/accounts/${accountId}/payments`, {
  tenancy_id: tenancy.id, amount_cents: 70000, currency: "USD",
  received_at: new Date().toISOString(), method: "check",
  allocations: [{ charge_id: charge.id, amount_cents: 70000 }]
});
// ledger.totals.rent_balance_cents === 50000

// 6. Tenant reports a leak via intake link
const token = await post(`/v1/accounts/${accountId}/intake-tokens`,
  { tenancy_id: tenancy.id });
// Share token.secret with tenant; they POST to /v1/intake/{secret}

// 7. Move-in inspection with photo
const inspection = await post(`/v1/accounts/${accountId}/inspections`,
  { area_id: unit.id, performed_at: new Date().toISOString(), notes: "Move-in" });

await post(`/v1/accounts/${accountId}/inspections/${inspection.id}/items`,
  { label: "Kitchen — appliances", condition: "Good" });

const form = new FormData();
form.append("entity_type", "inspections");
form.append("entity_id", inspection.id);
form.append("file", photoBlob, "kitchen.jpg");
await authedFetch(`/v1/accounts/${accountId}/attachments`, { method: "POST", body: form });

await post(`/v1/accounts/${accountId}/inspections/${inspection.id}/complete`, {});
// Report PDF stored as an attachment

// 8. Evidence export when tenancy ends
await patch(`/v1/accounts/${accountId}/tenancies/${tenancy.id}`,
  { status: "ended", end_date: "2026-08-31" });

const exp = await post(`/v1/accounts/${accountId}/evidence-exports`,
  { tenancy_id: tenancy.id });
// exp.chain_verified === true
// Download: GET /attachments/{exp.attachment_id}/download
```

*(Each `post`/`patch`/`put` call sets `Authorization` and a fresh `Idempotency-Key`.)*

---

## 15. Guarantees you can rely on

**Isolation**
You only ever see data for accounts you're a member of; everything else is `404`. Enforced at the database (row-level security), not just the API layer. Cross-account and cross-tenancy references always return `404` — the API never confirms that another account's record exists.

**Immutable audit trail**
Every consequential action is recorded as an immutable, server-timestamped, hash-chained audit event. Records are *corrected* by new entries — never silently overwritten. The sequence of events is verifiable: `chain_verified: true` in an evidence export means the chain hashes out cleanly from the first event to the last.

**Money integrity**
Balances are derived from charges minus allocations; they are never stored. Partial payments, voids, and `nsf_fee` reversals create new rows — they never mutate originals. Inline-allocation creates are atomic: if any part fails (over-allocation, cross-tenancy, currency mismatch), the entire call rolls back.

**Idempotency safety**
Every mutating call is protected by a server-side idempotency key. Retrying a network-failed request with the same key is always safe — you get the original response, never a duplicate write.

**File integrity**
Every uploaded file is stored with a server-computed SHA256 `content_hash`. The download endpoint returns `X-Content-Sha256` so you can verify the bytes haven't been corrupted in storage.

**Tamper-evident evidence**
Evidence exports embed a chain-of-custody for every file (upload time, hash, actor) and a full audit chain verification. Use the PDF directly in housing court or insurance claims without any additional attestation.

---

*Build against `/v1` and the generated types. The OpenAPI spec at `GET /openapi.json` is the authoritative contract. If something you need isn't expressible through this API, request it here rather than working around it — the invariants above only hold because all writes go through the contract.*
