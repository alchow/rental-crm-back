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
