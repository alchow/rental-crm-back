# `classify` correction kind — core team reply

**From:** core API team (rental-crm-api) · **To:** product/design + FE cloud team
**Re:** "body-immutable correction kind so a landlord can complete a record's
metadata (who/place/channel) after capture without it reading as a content edit"

**Status (2026-06-20): CONVERGED** — all five conditions accepted, channel
resolved (c); **greenlit for PR 1.** Negotiation history below.

Short version: **the concept is approved — it's arguably *more* faithful to
append-only than what you do today — but I'm not accepting the request as
written.** It has one audit-substantive hole that defeats its own headline
claim, one place where it would actively corrupt the legal artifact, two
factual errors ("no migration," "nothing to do at capture"), and an unstated
dependency. Conditional yes, with the five conditions in *What we'll
greenlight* — **all five since accepted by FE; see *Round 2* below for the
converged scope and three deltas surfaced in review.**

Credit first, because you earned it: forcing attribution through `amend` today
is genuinely wrong, and a distinct kind that records "metadata completed,
narrative untouched" is the honest model, not a loophole. The disagreement is
entirely about *bounding* it so it can't be used to silently change a contested
fact.

---

## Round 2 — converged (2026-06-20)

FE accepted all five conditions and resolved Problem 4 (**yes**, they need
who-type-unknown at capture — a landlord logs "spoke to Marcus about the leak"
without knowing at write time whether Marcus is a tenant or a vendor). Reviewing
that resolution surfaced **three deltas** neither side had written down; they are
folded into the sections below and the appendix. This is the at-a-glance current
scope.

**Delta 1 — `party_type='unspecified'` needs a coherence rule, not just a value.**
Unlike `direction` (#29, a standalone field), `party_type` has `party_id` /
`party_label` hanging off it, and **nothing ties them together today** (`party_id`
is free-floating nullable, `phase2_schema.sql:410`). Adding the value alone
permits an incoherent row — `party_type='unspecified'` *with* a concrete
`party_id` ("I don't know the role, but here's their exact ID"). So the sentinel
ships **with**: (a) DB CHECK `party_type='unspecified' ⟹ party_id IS NULL`;
(b) `'unspecified'` valid for communications only, never notes/agent_events
(those use `'none'`); (c) classify resolves `party_type` + `party_id` as a unit.
This also *shrinks* the ask: "which-tenant-unknown" (`party_type='tenant',
party_id=null`) is **already** legal and already fill-only-compliant, so
`'unspecified'` is scoped strictly to genuine role-unknown. See Problem 4.

**Delta 2 — the export shows no counterparty at all, today.** Re-reading the
renderer: a communication's root line is `direction + channel + actor` and
nothing else (`export-pdf.ts:935,946-948`) — it never prints
`party_type`/`party_id`/`party_label`. A pre-existing gap, but it makes classify
*invisible in the artifact*: after classify attaches Tenant X, the PDF still
wouldn't show X. So Condition 4 is bigger than relabeling — it must render the
counterparty on the communication root (resolved party name where `party_id`
joins, else `party_label`, else `unspecified`), then the classify row as the
attribution it added. See Problem 2.

> **Scope decision (2026-06-20): export *enhancement* stacked as PR 2.** The root
> counterparty rendering above goes in a stacked PR immediately on top of the
> classify PR — planned next, not parked. PR 1 (classify) still carries the
> *correctness* fix on its own — a classify row must not render as
> `Corrected: <body>` (no content changed); render it
> `Attribution completed by <actor> (logged <ts>)` — because PR 1 must be honest
> standalone in the short window before PR 2 merges. PR 2 then replaces that
> interim label with the resolved-party render. Only between the two merges do
> exported bundles not yet *name* the attached party (already true for every
> communication) — honest-but-incomplete, and only briefly.

**Delta 3 — channel: do (c), not the (a)/(b) you offered.** Your (b)
(live-default to `in_person`) fabricates a channel — out by your own principle.
Between a sentinel and the third option you didn't list, I recommend **(c): keep
your pre-commit channel inference; on an inference *miss*, prompt for a one-tap
channel pick rather than committing blank.** Two reasons: (1) **asymmetry** —
`party_type='unspecified'` is a *prerequisite* (NOT NULL makes the bare log
unstorable otherwise), but the medium is almost always known to whoever is
logging, so `channel='unspecified'` is optional and rare; (2) **evidentiary** —
"how you contacted them" is itself sometimes the disputed fact (letter vs.
verbal), and "channel unspecified" reads as *didn't record how*, weaker than
"recorded the contact, hadn't yet matched the person." Capture the cheap/known
thing (medium, one tap); defer the expensive/unknown thing (identity).
`channel='unspecified'` (your option a) is acceptable **only** if "commit a log
with zero channel info" is a hard product requirement — then it carries identical
fill-only + comm-only rules and you price in the send-pipeline/export blast
radius. **Out of the first PR either way.**

**One consequence to own (your side):** `party_type='unspecified'`/`party_id=null`
rows are dark to entity-search context (PRs #23–#28 join on the resolved party) —
they won't surface in a tenant's/vendor's history until classified. Design an
Enrich nudge / "needs attribution" surface so `'unspecified'` doesn't become a
dumping ground; otherwise classify's value never materializes.

---

## Where you're right

- **Append-only holds.** A `classify` row is a plain `INSERT` into
  `interactions`. The chain invariants are kind-agnostic and need no change:
  linear chains (`interactions_corrects_id_uniq`), same-account (composite FK),
  derived `is_head`/`superseded_by_id` via `interactions_with_chain`
  (`20260612000001_interactions_journal.sql`). `?latest_only=true` collapses to
  the new head with no change (`interactions.ts:344`) — your fourth acceptance
  criterion works as-is, because the `classify` row simply *becomes* the head.
- **A distinct kind is the more precise record.** Today, attaching a tenant
  forces an `amend`, and an `amend` **requires a new `body`**
  (`interactions.ts:192`) and re-states it into the new row
  (`interactions.ts:504`). So using `amend` to attach a tenant doesn't merely
  *look* like a content edit — it literally writes the body as changed content.
  Recording the metadata-completion as its own kind is strictly truer to what
  happened. Agreed on the premise.

## Problem 1 (the one that matters): `classify` as specified permits silent re-attribution

Your strongest claim is *"structurally impossible to launder a content change
through classify."* That is true for `body` and `occurred_at`. **It is false for
attribution** — and in a landlord–tenant dispute, *who* is frequently the single
most contested fact, more than the narrative text.

Your whitelist uses the same inherit-or-override mechanic as `amend`
(`interactions.ts:499-519`): omit → inherit, present → **overwrite**. Nothing in
the proposal restricts `classify` to *empty* fields. So this is permitted:

> 9pm: log "tenant threatened me," no party. → Two weeks later, mid-dispute:
> `classify` attaches Tenant **X**. → Later: `classify` re-points it to Tenant
> **Y** — **with no "edited" badge**, presented as a clean, complete record.

That is exactly the after-the-fact alteration of a contested fact the audit
design exists to expose, handed the "this isn't an edit" treatment.

**Condition — fill-only semantics.** `classify` may populate a field that is
currently **empty** (`NULL`, or the `unspecified`/`none` sentinel); it may
**not** overwrite a concrete value already on the chain head. Overwriting a
recorded fact is a change of account → that's `amend`, and it *should* read as
an edit, because it is one.

This is not a constraint on your use case — it *is* your use case ("we dropped
the required Who; attach it later" = `NULL → value`). And it makes your own
security claim actually true. It also auto-resolves the whitelist entries I'd
otherwise contest, with no hand-curated list:

| field | empty state | under fill-only |
| --- | --- | --- |
| `party_id`, `tenancy_id`, `area_id`, `maintenance_request_id`, `vendor_id`, `party_label` | `NULL` | fillable once ✅ |
| `direction` | `'unspecified'` (default, #29) | fillable once ✅ |
| `channel` | never empty (`NOT NULL`, set at capture) | not fillable → "it *was* a phone call, not in-person" stays an `amend`, exactly as `interactions.ts:376` already says |
| `party_type` | `'unspecified'` (new sentinel — Delta 1) | fillable once → concrete, resolved atomically with `party_id` ✅ |

To be evidence-grade this must be **DB-backstopped** (a `BEFORE INSERT` trigger,
sketch in the appendix), consistent with how the linear-chain index and
composite FK are justified: guarantees must hold "even under racing requests or
a direct write" (`20260612000001:19-21`). App-level validation alone is the
floor, not the bar.

## Problem 2: the evidence export would *lie* about a `classify` row

Worst possible place for a gap — the export PDF is the artifact a court reads,
and "it's all in the export" is your headline defense. The renderer branches
only `retract` vs. *else*:

```
api/src/admin/export-pdf.ts:951-963
  corr.correction_kind === 'retract' ? "Retracted: <body>" : "Corrected: <body>"
```

A `classify` row inherits the body, so it renders as **"Corrected: \<the
original body, repeated\>"** — telling a judge the *content* was corrected when
it wasn't, and showing nothing about the attribution that actually changed.
Worse than omission.

**And worse still (surfaced in review — Delta 2):** the root line never prints
the counterparty either — only `direction + channel + actor`
(`export-pdf.ts:935`). The export does not show *who* a communication was with,
today. Since classify is the feature that attaches the who, fixing the label
without fixing the root render would still leave the artifact silent about the
attribution.

**Condition (stacked — PR 1 + PR 2, 2026-06-20):**

- **PR 1 / classify (correctness, non-deferrable):** a `classify` row must
  render as what it is, e.g. `Attribution completed by <actor> (logged <ts>)`,
  **not** `Corrected: <body>`. ~2 lines at `export-pdf.ts:951`; no join needed.
  PR 1 has to be honest standalone, since it may sit live before PR 2 merges.
- **PR 2 / export enhancement (stacked immediately on PR 1):** render the
  resolved counterparty on the communication root (name where `party_id` joins,
  else `party_label`, else `unspecified`) and on the classify row, replacing
  PR 1's interim label. The pre-existing-gap fix — communications have never
  shown "who" in the PDF — needs a party join, so it's its own PR, but it's the
  immediate next one, not parked.

Either way the **export must never suppress the `logged_at` delta**, which is
itself the audit-relevant fact.
(The export already prints each correction's own `logged_at`, `export-pdf.ts:962`
— keep that; just stop mislabeling the row.)

## Problem 3: two factual errors

1. **"No migration." False.** `correction_kind` is a **DB CHECK constraint**,
   not just a TS enum: `check (correction_kind in ('amend', 'retract'))`
   (`20260612000001:42-43`). Insert `'classify'` without altering it → check
   violation → **500 in prod**. One-line `drop/add constraint` migration, but
   mandatory. (Pairing/FK/linearity already accept any value.)
2. **"Nothing to do at capture." Also false** — see Problem 4.
3. Minor but real: every correction today **requires `body`**
   (`interactions.ts:192`). `classify` omitting body (inherit) is a new branch
   in the `superRefine` — small, but it's code, not free.

## Problem 4: the capture side can't represent "no Who yet"

The proposal presupposes a validly-stored communication with an empty
counterparty. **It isn't storable today.** `party_type` is `NOT NULL` with no
"unknown" value for a communication — `'none'` is reserved for notes
(`phase2_schema.sql` + `interactions_party_type_check`; the note-shape
constraints in `20260612000001`).

- `party_id`, `tenancy_id`, `area_id`, `maintenance_request_id`, `vendor_id` are
  **nullable** → `classify` serves these cleanly under fill-only. ✅
- `party_type` itself has **no `unspecified` sentinel** → "log bare" can't even
  say "tenant-vs-vendor unknown." You'd be forced to write `party_type='other'`
  and later want `'other' → 'tenant'`, which fill-only (correctly) forbids.

**Resolved (Round 2): yes — who-type-unknown is required** (log "spoke to Marcus"
without knowing tenant-vs-vendor). So we add a **`party_type='unspecified'`
capture sentinel** — the same *shape* as `direction` in #29, but **not** the same
cost: `party_type` carries `party_id`/`party_label`, so the sentinel ships with a
coherence rule (Delta 1) — `party_type='unspecified' ⟹ party_id IS NULL`,
communication-only, and classify resolves type + id atomically. `classify` then
fills `unspecified → concrete`. (Note: "which-*tenant*-unknown" —
`party_type='tenant', party_id=null` — was already legal and already
fill-only-compliant, so the sentinel is scoped strictly to role-unknown.)

## Your three questions, answered

1. **Hash/signature/seal over rows?** Yes — a per-account SHA-256 hash chain on
   the `events` spine (`phase3_audit.sql`). `_emit_event` is an `AFTER
   INSERT/UPDATE/DELETE` trigger on `interactions` that hashes the **entire**
   `to_jsonb(NEW)` row — including `correction_kind` and every party field — into
   a `prev_event_hash`-linked chain (`phase3_audit.sql:119-195`); `verify_chain()`
   re-derives it; the Phase 11 cron sweeps it
   (`20260605000012_phase11_chain_sweep_and_janitors.sql`). **`classify` is
   sealed identically and automatically** — it's just another insert, and the new
   enum *value* doesn't touch the canonical form (the *column* is already
   hashed). Covered by `chain-mixed-era.test.ts` / `audit.test.ts`, not just a
   comment. Corollary worth stating: the spine hides nothing even from a bad
   re-attribution — which is why Problems 1–2 are about the **presentation**
   layer (export PDF + UI badge), the part people actually read, not the forensic
   layer.
2. **Consumers branching on `correction_kind`?** Three need work, one is a
   freebie:
   - **export PDF** (`export-pdf.ts:951`) — Problem 2, must update.
   - **SDK types** hardcode `"amend" | "retract"`
     (`sdk/src/generated/types.ts:8532,8577`) — regenerate from OpenAPI.
   - **`docs/api-guide.md`** + the `check:guide-drift` gate — update or CI fails.
   - Freebie: the retract-closes-chain guard (`interactions.ts:472`) already
     blocks *all* corrections of a retracted head, so `classify` on a retracted
     chain is auto-409'd. And the **agent firewall blocks every correction**
     (`agent-firewall.ts:47`) → `classify` is **landlord-only by construction**,
     which is the right answer (an agent silently re-attributing would be worse).
3. **422 `immutable_field`?** Prefer **not**. House convention is `400
   invalid_request` for all request-shape rejections (`error.ts`
   `validationFailure`; the analogous "correction can't change shape" rejections
   are already 400 at `interactions.ts:393,405`). `422` appears once, for a
   *domain* outcome (`send_failed`, `messages.ts:26`), not validation. Clients
   branch on `error.code`, never on status (`error.ts` envelope doc). So:
   **`400 invalid_request`, with the offending field named in `details`**
   (mirroring the firewall's `fieldErrors`), so FE can still branch
   programmatically. Minting a `422` here would make it the only
   request-validation path in the API doing so. Your `409
   invalid_correction_target` for a stale `corrects_id` is already correct and
   unchanged (`interactions.ts:477,613`).

## What we'll greenlight

`classify` on the existing `POST /interactions`, scoped to:

1. A migration that alters `interactions_correction_kind_check` to add
   `'classify'`.
2. **Fill-only**, DB-backstopped — never overwrites a recorded fact.
3. `body` / `occurred_at` change → `400 invalid_request` (field named in
   `details`), not 422.
4. SDK types + `api-guide.md` updated in the **same** PR. Export ships as a
   2-PR stack: PR 1 carries the **correctness** fix (classify must not render as
   `Corrected: <body>`); **PR 2, stacked immediately on top,** adds the root
   counterparty rendering (Delta 2).
5. `party_type='unspecified'` sentinel (**confirmed needed**) ships in the same
   PR **with** its coherence constraints — `party_type='unspecified' ⟹ party_id
   IS NULL`, comm-only, atomic resolve (Delta 1). A `channel='unspecified'`
   sentinel is **out** of this PR; prefer option (c) (Delta 3).

Under those, I agree it's net-additive to the audit guarantee — and the badge
suppression becomes *honest*, because filling a blank genuinely isn't altering a
stated fact.

One-line summary for the FE team: **you get `classify`, but it fills blanks — it
never silently changes an answer, and the export will say exactly what it did
and when.**

## Sequencing

1. **Only open question left: channel** — confirm (c) prompt-on-miss, or tell us
   "commit with zero channel info" is a hard requirement and we'll scope
   `channel='unspecified'` as a fast-follow (Delta 3).
2. **PR 1 — classify:** migration (add `correction_kind='classify'` **and**
   `party_type='unspecified'` + the coherence CHECK) + `superRefine` (`classify`
   branch, body-optional, immutable-field 400; accept/resolve `unspecified` at
   capture) + fill-only `BEFORE INSERT` trigger (incl. atomic party resolve) +
   **export correctness fix** (classify not labeled `Corrected:`) + SDK regen +
   guide + tests.
3. **PR 2 — export enhancement (stacked on PR 1, immediate next):** render the
   resolved counterparty on the communication root + the classify attribution,
   replacing PR 1's interim label. Brief window between merges where exported
   bundles don't yet *name* the attached party (already true for every
   communication today).
4. FE drops the edit badge for `correction_kind='classify'` only; export and
   full-chain views keep showing it with its `logged_at`. FE adds an Enrich nudge
   so `'unspecified'` rows get attributed (they're dark to entity-search until
   then).

---

## Appendix: contract sketch (illustrative, not final)

**Migration** — value-add to the existing check, no new table/column:

```sql
-- 1. the new correction kind
alter table public.interactions drop constraint interactions_correction_kind_check;
alter table public.interactions add constraint interactions_correction_kind_check
  check (correction_kind in ('amend', 'retract', 'classify'));

-- 2. the capture sentinel (Problem 4 / Delta 1)
alter table public.interactions drop constraint interactions_party_type_check;
alter table public.interactions add constraint interactions_party_type_check
  check (party_type in ('tenant', 'vendor', 'inspector', 'other', 'none', 'unspecified'));

-- 3. coherence: an unknown role cannot carry a resolved id. Applies to EVERY
--    row (capture AND classify), so it is a table CHECK, not just the trigger.
alter table public.interactions add constraint interactions_unspecified_party_no_id
  check (party_type <> 'unspecified' or party_id is null);
-- 'unspecified' is communication-only; notes/agent_events keep using 'none'
-- (interactions_note_fields already forces party_type='none' on channel='note').
```

**Validation** (`interactions.ts` superRefine) — `classify` makes `body`
optional and rejects substantive fields:

```
if correction_kind === 'classify':
  if body !== undefined        → 400 invalid_request  details.immutable_field='body'
  if occurred_at !== undefined → 400 invalid_request  details.immutable_field='occurred_at'
  // body omitted ⇒ inherit original.body (latest content row = the head)
```

**Handler** — a `classify` branch parallel to `isAmend`, inheriting body +
occurred_at unconditionally, applying whitelisted fields only when present.

**Fill-only DB backstop** — the evidence-grade half; rejects an overwrite even
on a direct write:

```sql
create function _reject_classify_overwrite() returns trigger as $$
declare orig public.interactions;
begin
  if NEW.correction_kind <> 'classify' then return NEW; end if;
  select * into orig from public.interactions where id = NEW.corrects_id;

  -- body + occurred_at are inherited, never changed
  if NEW.body is distinct from orig.body
     or NEW.occurred_at is distinct from orig.occurred_at then
    raise exception 'classify cannot change body/occurred_at' using errcode='check_violation';
  end if;

  -- whitelisted fields: may fill an EMPTY original, never overwrite a set one
  if orig.party_id is not null       and NEW.party_id       is distinct from orig.party_id       then raise exception 'classify cannot overwrite party_id'       using errcode='check_violation'; end if;
  if orig.tenancy_id is not null     and NEW.tenancy_id     is distinct from orig.tenancy_id     then raise exception 'classify cannot overwrite tenancy_id'     using errcode='check_violation'; end if;
  if orig.area_id is not null        and NEW.area_id        is distinct from orig.area_id        then raise exception 'classify cannot overwrite area_id'        using errcode='check_violation'; end if;
  if orig.vendor_id is not null      and NEW.vendor_id      is distinct from orig.vendor_id      then raise exception 'classify cannot overwrite vendor_id'      using errcode='check_violation'; end if;
  if orig.maintenance_request_id is not null and NEW.maintenance_request_id is distinct from orig.maintenance_request_id then raise exception 'classify cannot overwrite maintenance_request_id' using errcode='check_violation'; end if;
  if orig.party_label is not null    and NEW.party_label    is distinct from orig.party_label    then raise exception 'classify cannot overwrite party_label'    using errcode='check_violation'; end if;
  -- 'unspecified'/'none' count as EMPTY (fillable) for direction + party_type
  if orig.direction not in ('unspecified','none') and NEW.direction is distinct from orig.direction then raise exception 'classify cannot overwrite direction' using errcode='check_violation'; end if;
  if orig.party_type not in ('unspecified','none') and NEW.party_type is distinct from orig.party_type then raise exception 'classify cannot overwrite party_type' using errcode='check_violation'; end if;
  -- channel is never empty on a communication ⇒ effectively immutable here
  if NEW.channel is distinct from orig.channel then raise exception 'classify cannot change channel (use amend)' using errcode='check_violation'; end if;
  -- atomic resolve: naming a party_id requires resolving the role too
  -- (the table CHECK backstops the inverse: unspecified ⇒ party_id IS NULL).
  if NEW.party_id is not null and NEW.party_type = 'unspecified' then raise exception 'classify must resolve party_type when setting party_id' using errcode='check_violation'; end if;

  return NEW;
end $$ language plpgsql;

create trigger interactions_classify_fill_only
  before insert on public.interactions
  for each row when (NEW.correction_kind = 'classify')
  execute function _reject_classify_overwrite();
```

The app maps `check_violation` from this trigger to `400 invalid_request` the
same way it already maps the chain constraints to their domain codes
(`interactions.ts:609-622`).

**Channel (Delta 3) — deliberately not in this sketch.** Recommended path (c)
needs no backend change: FE keeps pre-commit inference and prompts for a one-tap
channel on an inference miss, so `channel` is always concrete at capture. Only if
"commit with zero channel info" is a hard requirement do we add
`channel='unspecified'` to the channel CHECK — and then it carries identical
fill-only treatment (`'unspecified'` counts as empty; concrete → concrete is an
`amend`) and you price in the send-pipeline (`messaging.sql` sets `channel='sms'`)
and the export's `channel` rendering.
