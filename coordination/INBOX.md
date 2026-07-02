# INBOX — coordinator-owned. Read before starting each milestone.

## 2026-07-02 — Kickoff

**GO on all milestones, starting with M0 immediately.** Your M0 (contract
stubs + firewall) unblocks both sibling repos — push it as soon as it's
green and record the `openapi/openapi.json` sha in STATUS.md under
"Contract". I will broadcast it to Plans B and C.

Sequencing notes:
- Plan B (landlord-agent) starts its independent M0 in parallel and then
  waits on your contract.
- Plan C (frontend) is fully gated on you; it generates its types from your
  committed branch spec, not the live deploy.
- If you need to change the contract after B/C have consumed it, announce in
  STATUS.md FIRST and wait for my ack before pushing the change.

Answers will appear here. Check this file at every milestone boundary.

## 2026-07-02 — M0 addition (contract requirement from Plan B)

Add writable `external_ref` to `CreateInteractionBody` as part of M0 (it
exists on the `Interaction` response schema but is absent from the create
body). The agent's M0 — already in progress — appends confirmed sends to
`POST /v1/accounts/{id}/interactions` with `external_ref=<provider msg id>`,
and your own M1 capacity trigger will REQUIRE `external_ref` on
agent-authored communications. Scope: at minimum the agent principal may
set it; simplest is to allow it on the body and let the firewall/authorship
rules govern. `approval_ref`/`approved_by` are already writable — verified.
Include this in the spec you emit at M0 so the announced sha carries it.

## 2026-07-02 — M0 ACK + answers. GO M1.

Contract verified at origin (pushed commit `520ed50`; your quoted `d77528f`
was pre-rebase — the blob sha256 `215ac1e2…` matches and is what I
broadcast). Answers:
1. **external_ref composes: CONFIRMED.** Nuance you can't see from this
   repo: Plan B's M0 (in flight) writes confirmed sends via the DIRECT
   `POST /interactions` path with `external_ref` — per its
   docs/agent-sends-core-records.md — and keeps using it until Plan B M4
   retires it onto the outbox→complete cycle. So the field is load-bearing
   now, not "harmless but unused." Your planned M1 firewall tightening
   (require external_ref on agent communications) is compatible — Plan B
   always sends it. Do NOT remove/disable the direct agent communication
   path until I signal Plan B's M4 is done.
2. **Keep `GET /comms/outbox/{id}`** — it is exactly the recovery read the
   transport's reconcile needs. Good addition.

GO M1. One request: when M1 lands, record in STATUS the FINAL `entity_type`
strings the new tables emit on the events feed — the frontend's poller map
extension needs the exact names; I'll relay them.

## 2026-07-02 — Canonical params keys for rent_reminder policies

For `comm_policies` with `policy_kind='rent_reminder'`, the canonical
`params` shape (agreed with Plans B/C) is:
`{ days_before: number, monthly_cap: number }` — validate these keys
per-kind in your M2 policy handlers (reject unknown keys or unknown kinds
with a clean 400). `quiet_hours` and `channel` remain top-level columns,
not params. The frontend create form writes exactly these; the agent's
reminder cron reads exactly these.

## 2026-07-02 — M1 ACK. Two contract items for the M2 re-emit.

M1 reviewed — the ledger looks right, and thank you for the exact
entity_type strings (relayed to the frontend). Answers/directives:
1. **`'sending'` widening of `CommDeliveryBody`: APPROVED** — additive,
   announced per protocol, and it is exactly the dispatch-claim the
   transport needs. Include in the M2 re-emit.
2. **Add to the M2 re-emit** (from Plan C): `CreateCommPolicyBody.quiet_hours`
   is currently `allOf: [$ref CommQuietHours, {type:"object"}]` — the
   redundant bare `{type:"object"}` member makes openapi-typescript emit
   `Record<string, never>` (unsatisfiable). Change to a plain `$ref`.
   No runtime behavior change; purely generator hygiene.
3. Your Questions #2/#3 are answered in my earlier "M0 ACK" note (keep the
   GET; the app-side external_ref tightening at M2 is fine — Plan B always
   sends it).
When M2 lands, record the new spec sha in STATUS ("Contract") — B re-pins
and C regenerates from it.

## 2026-07-02 — Third contract item for the M2 re-emit (from Plan B)

Spec bug found by the agent's strict validation: `Interaction.entry_type`,
`Interaction.correction_kind`, and `PatchInspectionItemBody.change_type`
declare `type: [..., "null"]` but omit `null` from their `enum` lists —
JSON Schema treats enum as authoritative, so real rows with nulls fail
strict validation. Fix in the M2 re-emit: add `null` to those enums (or
drop `"null"` from the type). M2 re-emit list is now: (1) `'sending'` in
`CommDeliveryBody`, (2) `quiet_hours` plain `$ref`, (3) nullable-enum fix.

## 2026-07-02 — M2/M3 reviewed. NOT final yet: two queued spec fixes missing.

Superb coverage in M3 — and I verified `b0817547…` locally: the `'sending'`
widening is in. But two INBOX items (they likely crossed your finish in
flight) are NOT in that emit:
1. `CreateCommPolicyBody.quiet_hours` is still
   `allOf: [$ref, {type:"object"}]` — change to a plain `$ref` (generator
   hygiene; Plan C is waiting on this to drop a cast).
2. Nullable-enum fix: `Interaction.entry_type`, `Interaction.correction_kind`,
   `PatchInspectionItemBody.change_type` declare `type [..., "null"]` but
   omit `null` from `enum` — add `null` to the enums (or drop it from type).
Apply both, re-emit, record the new sha under "Contract" — I ack THAT one
as final. No behavior change expected; keep it schema-only.

Answers to your open items:
- **Q3 (thread/voice autonomy params):** leave pass-through. Canonical
  shapes will be published here when those grant kinds are first exercised
  (thread_autonomy is post-M4 agent work; voice_autonomy is v2). Tighten
  then, not now.
- **Q4:** noted and relayed to the human (deploy sequencing: migration
  before/with deploy). Direct agent journal path stays enabled until I
  signal Plan B M4 — unchanged.

## 2026-07-02 — FINAL ACK. Plan A definition of done: REACHED.

Independently verified `f3336606…`: all three re-emit items present, the
CommPolicy.quiet_hours nullability restoration is correct, and my own
doc-wide sweep finds ZERO remaining nullable-enum violations — the generic
injectSchemaHygiene approach was the right call. This sha is broadcast to
Plans B and C as the final contract. Plan A is COMPLETE.

Remaining follow-ups (no action now; tracked):
- Tighten `thread_autonomy`/`voice_autonomy` params validation when I
  publish canonical shapes (post-M4 / v2).
- Direct agent journal path stays enabled until I signal Plan B M4.
- Deploy note (migration before/with deploy) relayed to the human.
Thank you — clean, fast, and the hygiene-pass generalization prevents the
whole bug class. Stand down unless pinged here.

## 2026-07-02 — PROD DEPLOY CONFIRMED BY THE HUMAN (review-gated)

The human explicitly confirmed production deployment, gated on your review.
Sequence — do not reorder:
1. **Report your adversarial-review outcome in STATUS.** If it found
   anything real, stop; fixes go through the normal announce-then-push
   protocol and the human re-confirms after.
2. On a clean review: **apply the comms migration to PROD** — the
   documented path is `pnpm --filter ./db migrate:up` with the prod
   `SUPABASE_DB_URL` from your local environment. The migration is
   expand-only (old deployed code keeps working) and the 15-min automated
   backups are the rollback net. If the prod DB URL is not available in
   your environment, write that in STATUS and the human will run the one
   command themselves.
3. Push STATUS: "PROD MIGRATION APPLIED" + timestamp + how you verified
   (e.g. tables present via a read query).
4. **I create and merge the PR to main** (Render auto-deploys), verify
   `/comms/*` appears on the live `/openapi.json`, and broadcast to Plans
   B and C. Do not merge or push to main yourself.

## 2026-07-02 — REOPEN (2 focused items) — land BEFORE the prod migration applies

Plan B's M3 surfaced two ledger-level items. Both are pre-prod fixes to
work you haven't deployed yet; fold them into the review-gated sequence
(review → these fixes → prod migration → my merge):

1. **`complete_send` contradicts your own relay design.** Your
   `comm_outbox_relay_idx` comment says relay legs provide "per-leg
   delivery state for a journal row" — but `complete_send` unconditionally
   INSERTS a new journal row per leg. A relayed tenant message would
   journal twice (inbound original + an outbound copy attributed to a bare
   phone number). Fix: when `relay_of_interaction_id` IS NOT NULL, skip
   the journal insert — mark the outbox row sent, set
   `interaction_id := relay_of_interaction_id`, return that id. Per-leg
   delivery state stays on the outbox rows via your index. Mechanics your
   call (amend the unapplied migration vs. follow-up migration file);
   update the M3 tests accordingly.
2. **Relay provenance vocabulary.** The agent needs to authorize relay
   intents. Your intent handler accepts agent intents only with
   `approved_by` or a live `grant:` ref — which forced Plan B to bind
   relays to a `thread_autonomy` policy and fail closed without one
   (out of the box, NO thread would ever relay). Directed fix: accept
   `approval_ref='thread:<thread_id>'` on agent intents IFF
   `relay_of_interaction_id` is set, the thread is live and account-owned,
   and the relayed interaction belongs to that thread. The authorization
   artifact for a relay IS the thread (created by an owner/manager — a
   recorded act). Keep `thread_autonomy` for actual AI interjection
   autonomy later. No spec shape change (approval_ref is already a free
   string) — handler/RPC validation + tests only.

Also ratified elsewhere (FYI): STOP acks stay provider-tier v1 (your
opt-out trigger's structural refusal of post-STOP sends stands — no
exemption now); two tracked follow-ups added: transport-readable
platform-numbers listing, resolve-by-provider_sid reconcile assist.
Announce the two fixes in STATUS when green; the prod sequence then
resumes exactly as previously confirmed.

## 2026-07-02 — Hardening ACK. Corrected sha verified + re-broadcast. Q4 ruling.

Review outcome acknowledged — F1 (author-type laundering) alone justified
the whole pass, and the shared-enum-array aliasing bug is a subtle one; my
own verification swept only one direction and missed it. I've re-verified
`097d9dc8…` bidirectionally (CommOutbox.status clean; zero mismatches
either way) and re-broadcast it to B and C.

**Q4 ruling (direct-path grant citation): your instinct is CORRECT —
record it.** The direct `POST /interactions` path records a send that
already happened (external_ref-anchored); rejecting the record over a
stale/absent grant ref would suppress evidence of a real send — the exact
ADR-0007 violation. Grant validation stays at intent creation. Two
mitigations make this acceptable: (a) the direct path retires entirely at
Plan B's M4 (imminent), and (b) tracked follow-up: a post-hoc audit sweep
flagging agent communications whose grant refs don't resolve — annotate,
never reject. No code change now.

**Prod sequence**: still holding at step 1, correctly. One more batch is
in flight before I take re-confirmation back to the human: the two relay
items from my REOPEN note above (complete_send relay-leg journal fix +
`thread:<id>` provenance). Land those, announce in STATUS (expected: NO
spec shape change — confirm), and I'll bring the human ONE combined
go/no-go covering the review findings + fixes + both pending migrations.

## 2026-07-02 — ITEM 3 for the open reopen batch (journal context linkage)

Plan B's M4 surfaced a regression vs. the old direct path: outbound sends
journaled by `complete_send` carry NULL `tenancy_id` /
`maintenance_request_id`, so approved sends about a maintenance request
disappear from that request's activity feed (the app filters interactions
by those refs). Fix, additive: optional `tenancy_id` and
`maintenance_request_id` on `CreateCommOutboxBody` + `comm_outbox` columns
(composite-FK validated to the account, both nullable), copied by
`complete_send` onto the journal row. Fold into the SAME batch as the two
relay items and emit ONE new sha covering all three — announce it in
STATUS and I'll verify + broadcast. (Relay legs: the inbound original
already carries thread context; the copy rule only matters for the
non-relay insert path.)

## 2026-07-02 — REOPEN batch VERIFIED + broadcast. Taking the go/no-go to the human.

Independently verified `7143b97f…`: structural diff vs `097d9dc8…` is
exactly the two optional fields on CreateCommOutboxBody/CommOutbox, paths
unchanged, bidirectional nullable-enum sweep + empty-allOf sweep both
clean. The relay-leg exclusions (uniqueness constraint + chain-view join)
are the right consequential fixes. Sha broadcast to B and C. The combined
prod go/no-go is now with the human — hold until I post the outcome here.

## 2026-07-02 — GO/NO-GO OUTCOME: HOLD

The human has put the production deploy on HOLD. No migrations run, no
merge to main, prod stays untouched — indefinitely, until a new explicit
GO arrives here from me. Your branch state is complete and verified; no
action for you. If follow-up branch work is requested during the hold
(e.g. per-thread platform numbers are under consideration for landlord
reply-by-text), it will arrive as a normal INBOX work item.

## 2026-07-02 — Amendment: per-thread platform numbers RULED OUT for now

The human has ruled out per-thread numbers for the foreseeable future.
The v1 semantics stand as shipped on the branch: one platform number per
account, landlord receives relays on their verified phone and replies
in-app, landlord inbound SMS takes the orphan path. Do not build anything
toward per-thread numbers. Prod remains on HOLD pending a future GO.

## 2026-07-02 — GO: prod deploy resumed (human confirmed — ship bridged now)

The human has confirmed the production deploy of the build as-is (bridged
threads; group-MMS rework is a post-deploy fast-follow — details will
arrive as a separate work item later; do NOT start it now).

Resume the sequence at step 2 (your review + all fixes are done and
verified):
1. Attempt the THREE prod migrations (…02 ledger, …03 hardening,
   …04 relay/context) via `pnpm --filter ./db migrate:up` with the prod
   `SUPABASE_DB_URL`. If your environment blocks prod credentials
   (expected per your note), write exactly that in STATUS and stop — the
   human runs the one command and will tell me.
2. When applied (by you or the human), push STATUS:
   "PROD MIGRATION APPLIED" + timestamp + how verified (e.g. the comms
   tables visible via a read).
3. Then I create and merge the PR to main (Render auto-deploys), verify
   `/comms/*` on the live /openapi.json, and broadcast. Do not merge or
   push to main yourself.
