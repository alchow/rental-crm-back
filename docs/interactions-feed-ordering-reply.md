# Reliably-followable interactions feed — core team reply

**From:** core API team · **To:** landlord-agent team
**Re:** `RentalAgent/docs/core-asks-feed-ordering.md` (append-ordered cursor and/or webhooks)

Short version: **your diagnosis is correct, and the fix already exists — but it
isn't Option A.** We are **not** going to add a `logged_at`-ordered cursor to
`/interactions`, because `logged_at` cannot give you the "never miss" guarantee
you're paying for (details below), and because we already ship a feed that
*can*: `GET /v1/accounts/{accountId}/events`, keyed on a gap-free per-account
sequence. Point your `PollingSource` at that and you get everything Option A
promised — no overlap, no re-reads, no page-cap — with a *provable* lossless
guarantee instead of a best-effort one. Adopting it needs **zero new core
code**; your token already has access.

Option B (webhooks) is a real and welcome ask, but a separate project. It
should be built on the same event log, with that feed as its reconciliation
backstop.

---

## You diagnosed it correctly

We confirmed the behavior you probed:

- `/interactions` pages on `occurred_at ASC`, cursor `{created_at: <occurred_at
  of last item>, id}` (`api/src/routes/interactions.ts` list handler;
  `api/src/routes/_lib/cursor.ts`).
- `occurred_at` is client-supplied event time
  (`db/.../20260604000001_phase2_schema.sql` — `interactions.occurred_at`).
- A backdated row therefore sorts *behind* a forward cursor and is never in any
  page a forward follower fetches. That's a pagination problem, not a sort
  problem — exactly as you wrote it.

So the workaround (re-read from `HWM − 7d` + PK dedupe), its 7-day blind spot,
and the 5,000-item page-cap silent-miss are all real. We want them gone too.

## Why we're declining Option A (the `logged_at` cursor)

`logged_at` defaults to `now()` (`phase2_schema.sql` — `logged_at timestamptz
not null default now()`). **`now()` in Postgres is transaction *start* time, not
commit time.** A keyset cursor on a start-time column has the *same* disease as
`occurred_at`, only with a smaller window: a transaction that starts early and
commits late writes a row whose `logged_at` is *behind* a high-water mark a
poller has already advanced past → silent miss.

This is not hypothetical in our system:

- **The import executor runs the entire import in one transaction**
  (`api/src/admin/import-executor.ts`). Every interaction it inserts is stamped
  `logged_at = the import's start time`, and they all become visible together at
  commit — potentially minutes later. A `logged_at`-cursor follower that polled
  during the import and advanced its HWM past that start time would **silently
  drop the entire import.** Your proposed "shrink the overlap to zero" makes this
  a guaranteed miss, not an edge case.
- Ordinary concurrent writes have the same race at sub-second scale.

So Option A would not let you delete the overlap — you'd still need a non-zero
margin + your PK dedupe, i.e. most of the workaround you're trying to retire. It
shrinks the miss window; it does not close it.

Two more costs you can't see from outside:

- **Cursor ambiguity.** Our cursor helper encodes the keyset value under a fixed
  JSON key (`cursor.ts`). A `logged_at`-ordered cursor and an `occurred_at`-
  ordered cursor are byte-shaped identically but semantically incompatible —
  replaying one against the other ordering yields **silently wrong data, no
  error** (both are timestamps; the filter just compares the wrong column). A
  correct implementation has to bind the order mode into the cursor and reject
  mismatches. Permanent extra surface.
- **A new index + a sorted view.** We have no `(account_id, logged_at, id)`
  index (only the `occurred_at` one, `20260613000001_pagination_indexes.sql`),
  and `/interactions` orders a *view* that left-joins the correction chain and
  the outbox. Without a new partial composite index, `order=logged_at` is a
  scan-and-sort over a join, not a range scan. "Small on your side" is "new
  index + new cursor mode + retained overlap" on ours — to get a *weaker*
  guarantee than what's below.

## Use this instead: `GET /v1/accounts/{accountId}/events`

We already built the lossless feed. It's keyed on `account_seq`, a per-account
`bigint` ordinal that is (ADR-0001; `20260605000001_phase31_audit_amendments.sql`):

- assigned `prev + 1` **under a per-account advisory transaction lock**, so
  per-account writes serialize and **`account_seq` order == commit order**;
- **gap-free from 1**, enforced (`events_account_seq_uk` unique) and asserted by
  `verify_chain`;
- committed in the *same* transaction as the row it describes.

That advisory-lock-serialized ordinal is exactly the commit-monotonic property
`logged_at = now()` lacks. A poller on `after_seq=<last seen>` **can provably
never miss or double-see a committed event** — and that's covered by a
concurrency test (10 concurrent writers vs. a draining reader, asserting a
strictly-increasing, exact-multiset seq, including an `entity_type=interactions`
filter), not just a comment.

It fits your trigger use case directly:

- Every interaction insert is audited — the audit trigger attaches to
  `interactions` (`phase3_audit.sql`), so inbound Twilio, imports, and confirmed
  sends all emit an event. No insert path bypasses it.
- Filter to what you trigger on: `?entity_type=interactions`.
- `snapshot` is the **full raw interaction row** (`payload.after =
  to_jsonb(NEW)`), so you can decide whether to act straight off the feed —
  `snapshot.channel`, `snapshot.direction == 'inbound'`, `snapshot.body`, party
  and context ids — **without a hydrate round-trip** in the common case.
- **No new access needed.** The feed's RLS gate is `is_account_member(account_id)`
  (`phase3_audit.sql`), the same gate that lets your token read `/interactions`.

### Request / response

```
GET /v1/accounts/{accountId}/events?entity_type=interactions&after_seq=0&limit=200
→ {
    data: [
      {
        account_seq: 4412,                      # integer HWM — pass back verbatim
        entity_type: "interactions",
        entity_id:   "<uuid>",                  # the interaction id
        event_type:  "inserted",                # 'inserted' | 'updated' | ...
        occurred_at: "2026-06-20T17:03:11Z",    # audit event time
        actor:       "system:twilio-inbound",
        snapshot:    { ...full interactions row... }   # payload.after
      }
    ],
    next_seq: 4412                              # pass as after_seq next poll
  }
```

Cursor is a plain integer. Empty page returns your requested `after_seq`
verbatim. No opaque encoding, no overlap, no re-reads.

### What changes on your side

- `PollingSource` follows `after_seq` instead of the `occurred_at` cursor; HWM is
  the last `account_seq` seen.
- Drop `DEFAULT_OVERLAP_MS` to **zero** — this is the feed where that's actually
  safe.
- Delete the `page_cap_hit` path. The integer keyset leaves nothing behind; a
  busy account just means more pages, never a dropped item.
- Trigger filter becomes `event_type == 'inserted' && entity_type ==
  'interactions'` over the snapshot. (Corrections/retractions are new inserted
  rows too, so they arrive the same way; `updated` carries before/after if you
  ever want edits.)
- Keep dedupe by `account_seq` (or `entity_id` for your existing PK collapse) —
  harmless, and it future-proofs you for webhooks.

## Two honest differences (so you're not surprised)

We won't oversell it. Versus polling `/interactions`:

1. **`snapshot` is the raw DB row, not our API `Interaction`.** It lacks the
   derived fields (`is_head`, `superseded_by_id`, `delivery_status`,
   resolved `author_type`) and is keyed by DB column names. **Guidance:** trigger
   off the snapshot; when you need the evidence-grade row, **hydrate via `GET
   /interactions/{id}`** (the feed gives you `entity_id`). We will treat the
   trigger-relevant interaction snapshot fields (`channel`, `direction`, `body`,
   `party_type`/`party_id`/`party_label`, `occurred_at`, `logged_at`, and the
   context ids) as a **documented, stable contract** — if we ever change them
   we'll version it, not silently reshape it.
2. **It's a shared feed.** The scan index is `(account_id, account_seq)` only —
   deliberately, so we don't tax every audited write in the system to speed one
   consumer (`events.ts` header). You post-filter to `interactions`, so on an
   account with heavy *non*-interaction write volume you'll page through events
   you discard. This is the one axis where a dedicated interaction cursor would
   win. We're choosing not to pre-optimize it; the revisit trigger is already
   documented (feed p95 > 200ms or > 20k events/account). **If** it ever bites,
   the fix is a dedicated interactions feed ordered by a commit-serialized
   ordinal — Option A's *shape* with the correct *key* — not `logged_at`. Tell
   us if your measured filter-yield is low and we'll prioritize it.

## Option B (webhooks): yes, but as its own project

Webhooks are the only thing that fixes *latency* (real-time vs. your ~45s poll);
the events feed doesn't change that. We're in. Two clarifications:

- "Mirror our WhatsApp webhook" is *inbound* signature verification. Option B
  asks us to become a reliable webhook **sender**: outbound delivery with
  retry/backoff, endpoint registration, secret storage + rotation, per-account
  fan-out, dead-lettering. That's an ADR and a worker, not an afternoon.
- Good news: we already have the substrate. `message_outbox` is a transactional
  outbox + worker, and `events` is the committed, ordered log to drive it. The
  intended design is a delivery worker tailing the event log, POSTing with
  `X-Hub-Signature-256` HMAC, using `account_seq` as the idempotency/dedupe key.
  Your reconciliation backstop then becomes the *same* events feed — which is
  why adopting the feed now is the right first move regardless.

## Sequencing

1. **Now — adopt the events feed.** Zero core code; strictly more correct than
   `logged_at` ordering. We'll publish the interaction-snapshot field contract
   and a short `PollingSource` migration note alongside this doc.
2. **Option A (`logged_at` cursor): declined as specified**, for the
   commit-reorder + import reasons above. Door open to a *seq-keyed* dedicated
   interactions feed if you measure the shared-feed filter yield to be too low.
3. **Option B: scoped separately** when latency matters, built on
   `message_outbox` + `events`, with the events feed as its backstop.

## What we'll commit to

- The interaction-snapshot trigger fields above as a stable, versioned contract.
- The `next_seq` / `after_seq` integer-cursor contract documented on the events
  route (already in OpenAPI).
- A revisit on a dedicated interactions feed if you bring measured evidence the
  shared feed's filter yield is hurting you.

Net: your engineering instinct — append-ordering + integer HWM + structural
dedupe — was exactly right. You'd just be rebuilding, more weakly, a feed we
already shipped one endpoint over. Switch the follower to `/events`, delete the
overlap for real, and we'll take latency up next as Option B.
