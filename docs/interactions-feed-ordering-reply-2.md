# Re: adopting `/events` — snapshot contract, with one source-side correction

**From:** core API team · **To:** landlord-agent team
**Re:** your ack `RentalAgent/docs/core-asks-feed-ordering-reply-ack.md` to our
`RentalCRMBack/docs/interactions-feed-ordering-reply.md`

Short version: **cut over — your trigger discriminators are correct.** But one
field in your required set, `maintenance_request_id`, is **`NULL` on every
inbound row at the source**, so the vendor-reply routing you described won't
work as built. That's not a contract-shaping problem; it's an ingestion gap, and
hydrating wouldn't fix it either. Read item 1 before you write matching logic.
The rest of your ask we'll honor, tightened and backed by a CI test instead of a
prose promise.

## 1. `maintenance_request_id` is `NULL` on inbound — read this first

You listed it as required:

> *"`maintenance_request_id` — routes a vendor reply to its waiting workflow;
> without it a vendor reply can't be matched and is silently left for the
> landlord."*

We traced the inbound path. The capture RPC `capture_inbound_sms`
(`db/.../20260616000004_inbound_messaging.sql`) **hardcodes
`maintenance_request_id`, `tenancy_id`, `work_order_id`, and `area_id` to
`NULL`** (the `values (...)` block). The call site
(`api/src/admin/twilio-webhooks.ts`, the `matches.length === 1` branch) resolves
an inbound message **only to a party** — tenant or vendor, matched by phone
number — and passes no work/maintenance context. So on exactly the rows you
trigger on, that field is structurally empty.

This is a **source** gap, not a snapshot gap: `GET /interactions/{id}` returns
the same `NULL`, so hydrating doesn't recover it. We won't put
`maintenance_request_id` in a versioned contract, because guaranteeing the
*presence* of an always-null field is a false guarantee that would send you to
build matching on data that isn't there. You probed `inbound=0`, so you've never
actually seen an inbound row's snapshot — this is what one looks like.

**What is populated for correlation on inbound:**

- `party_type` (`'tenant'` | `'vendor'`), `party_id`, and — for vendors —
  `vendor_id` (= `party_id`; set by the RPC when `party_type='vendor'`).
- `kind='communication'`, `direction='inbound'`, `channel='sms'`, `body`,
  `occurred_at`, `external_ref` (the provider SID).

**Routing a vendor reply, the pragmatic way (no core change):** you sent the
outbound, so you hold the state "awaiting a reply from vendor X re work-order Y."
Match the inbound by `vendor_id` (+ recency) against that state. That's the
correlation handle that actually exists today.

**If you want server-side correlation instead** — us threading the
maintenance/work-order context onto inbound capture (inferred from the most
recent outbound to that number, or a correlation token carried on the outbound
and echoed in the reply) — that's a **separate, explicit ask** with real design
behind it (SMS doesn't thread reliably; last-outbound inference can mis-attribute
when a vendor handles two jobs at once). File it and we'll scope it. It is not in
scope for "name the field in the contract."

## 2. A carve-out your "never miss an inbound" doesn't yet cover

Inbound from an **unrecognized or ambiguous** phone number is **never
journaled.** `twilio-webhooks.ts` (the `length === 0` and `> 1` branches) stores
those as raw `unmatched`/`ambiguous` with **no `interactions` insert** — so they
produce no event and never appear in `/events`. That's deliberate (we don't route
a text from an unknown sender into automation), but it means a real class of
inbound is invisible to a feed-follower, upstream of the feed entirely. Please
either accept this carve-out explicitly or open it as its own ask — don't let it
hide inside the "never miss" guarantee.

## 3. The snapshot contract — tightened and enforced

We'll honor the ask, with three changes:

- **Guaranteed present + typed** in the `entity_type='interactions'` snapshot:
  **`kind`, `direction`, `party_type`, `body`, `occurred_at`.** All populated and
  stable on inbound rows. These are the fields your cheap filter and your
  trigger decision actually need.
- **Drop `id`** — `EventFeedItem.entity_id` already carries the interaction id as
  a top-level, OpenAPI-typed field (`events.ts`). Use that; it's already under
  contract. Don't read `id` from the opaque snapshot.
- **`maintenance_request_id`: not contracted** (item 1). `vendor_id` / `party_id`
  are the populated correlation handles; we'll name those as guaranteed-present
  too, with the explicit caveat that `vendor_id` is non-null only when
  `party_type='vendor'`.

**Compatibility rule, stated precisely** (so "versioned" means something):

- Enum **value-set growth is additive and non-breaking.** We added
  `mutual`/`unspecified` to `direction` in #29; your `direction == 'inbound'`
  filter is unaffected, and future additions won't be either. Design your filter
  as an allowlist (`== 'inbound'`), never a denylist.
- A field **rename, removal, or type change** is the breaking change that gets a
  version bump and advance notice.

**Enforcement, not prose.** The OpenAPI types `snapshot` as `unknown`, so a doc
promise is unenforceable — a column rename would surface in *your* prod, not our
CI. So we'll add a **contract test** asserting these fields are present and typed
in the events-feed snapshot for an `interactions` insert. That moves a contract
break to our CI, which is the only version of this guarantee that's actually
maintainable. This is the gating item on our side; the doc guarantee is live the
moment that test lands.

## 4. Filter-yield / dedicated feed — agreed, deferred

Your `agent_event`-exhaust-dominates observation is a real structural signal, and
your own numbers (`inbound=0`, 158 events / ~11 days) say it's a hypothesis, not
a problem yet. The door-open fix stands: a dedicated seq-keyed interactions feed
that filters `direction`/`kind` server-side, so you stop paging your own exhaust.
Bring real inbound-yield numbers once accounts have inbound volume and we'll
weigh it against the p95/20k trigger.

## Net

- **Cut over now** on `kind='communication' && direction='inbound'` triggering —
  those values are correct and stable.
- **Re-plan vendor-reply routing** around `vendor_id` + your own awaiting-reply
  state, *not* `maintenance_request_id` (null at source). Or file the inbound-
  context-threading ask separately.
- **Snapshot contract:** `kind, direction, party_type, body, occurred_at`
  (+ `vendor_id`/`party_id` for correlation), `entity_id` for the id, enforced by
  a CI test we'll add. `maintenance_request_id` and `id` are out, for the reasons
  above.
- **Decide** on the unmatched/ambiguous-inbound carve-out: accept it or open it.
