# `GET /search` context enrichment — core team reply

**From:** core API team · **To:** landlord-agent team
**Re:** `RentalAgent/docs/core-asks-search-context.md` (enrich `SearchResult.context` per entity type)

Accepted — the asks are well-justified and we verified every requested field
against the schema. This is the running plan and the decisions as built.

## Shape: tagged discriminated union on `context.kind`

`SearchResult.context` is a union, one arm per entity kind, each tagged with a
literal `kind` so `openapi-typescript` narrows automatically (no casting on the
sibling `entity_type`):

```
context: TenantContext | AreaContext | … | null     # oneOf, discriminant = context.kind
```

`context` is `null` for kinds not yet enriched and for an entity with nothing to
resolve (e.g. a tenant with no tenancy). Additive: existing tenant fields are
unchanged — the former `SearchContext` object is now **`TenantContext`** with a
`kind:"tenant"` tag added.

**Naming note:** the area's own unit/common kind is exposed as **`area_kind`**,
because the union discriminator owns `kind`.

## Decisions (all confirmed)

| Topic | Decision |
|---|---|
| Union shape | Tagged on `context.kind` (your call — automatic narrowing in your generated client). |
| `vendor.trade`/category | **Separate track** — it's a vendor-categorization feature (new column + vendor CRUD + landlord-set + searchable), not search-context. On the radar as the next most-wanted; name-substring matching holds meanwhile. Timing TBD with product. |
| `vendor.status` | No new field — deactivated = soft-delete (`deleted_at`), already excluded from search. |
| `property.owner_name` | Dropped — account = owner, can't disambiguate within an account. Use `address` + `unit_count`. |
| `tenant` adds | Additive: keep the single current-tenancy context unchanged; add `is_primary` + `other_tenancies[]` (PR 2). Not converting context to an array. |
| `maintenance_request.tenancy_id` | Provided but **labeled derived** (the area's current tenancy — a scope hint, MR has no stored tenancy). |

## Staging

| PR | Scope | Status |
|---|---|---|
| **PR 1** | `area` context + the tagged union shape (`TenantContext` + `AreaContext`) | **Done** (#25) |
| **PR 2** | `maintenance_request` + `property` context; `tenant` `is_primary` + `other_tenancies[]` (`TenancyRef`) | **Done** (#26) |
| **PR 3** | `vendor` context (`contact`, `last_used_at`, `job_count`) — all 5 context arms now complete | **Done** — this PR |
| Separate track | vendor `trade`/categorization (schema + CRUD + searchable) | needs product sign-off |

## What PR 1 ships — `AreaContext`

```
AreaContext:
  kind:              "area"
  property_id:       uuid          # the disambiguator (two "Apt 1" across buildings)
  property_name:     string
  address:           string|null   # property line1
  area_kind:         string        # unit | hallway | … (the area's own kind)
  active_tenancy_id: uuid|null     # RELATIONAL handoff — "the tenant of this unit", no second fetch
  tenant_names:      string[]      # occupant names for the confirmation card
  occupancy_status:  "occupied" | "vacant"
```

Resolved server-side through the area's most relevant active/holdover tenancy.
Computed only for the rows that survive `ORDER BY … LIMIT`, and `SECURITY
INVOKER` so RLS scopes every read. All fields derive from existing tables — no
schema change.

## Backward compatibility

Additive. Tenant context fields are unchanged (renamed component
`SearchContext` → `TenantContext`, plus the `kind` tag). `area` goes `null` →
populated. `vendor`/`property`/`maintenance_request` stay `null` until their PRs.
When this lands, the drift gate carries the new schemas into the committed
`openapi.json` + SDK; regenerate to pick up `AreaContext` and build the
`AreaAdapter`.

*Migration `20260620000003_search_area_context.sql` — `CREATE OR REPLACE` of
`search_entities` only; no signature/index change.*
