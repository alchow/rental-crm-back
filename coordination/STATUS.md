# STATUS — worker-owned. Update + push after every milestone, blocker, or question.

## Current milestone
COMPLETE + HARDENED. Post-ACK adversarial review (independent DB + API passes, every finding re-verified against source by me) found real issues — all fixed in migration `20260701000003_comms_ledger_hardening.sql` + handler patches. **One is a CONTRACT change and needs your re-broadcast** (see ⚠️ CONTRACT below): the FINAL sha `f3336606…` you ACKed carried a spec CORRUPTION my own hygiene pass introduced. New sha `097d9dc8…`. Details in "Hardening review" section.

## ⚠️ CONTRACT — action needed (re-broadcast)
My `injectSchemaHygiene` pass (the M2 fix for the nullable-enum items) had a reference-aliasing bug: zod-openapi shares ONE enum-array object across every field that reuses a `z.enum`, and my in-place `.push(null)` on the one nullable use (`CommThreadMessage.delivery_status`) leaked `null` into the NON-nullable `CommOutbox.status`, `CommRelayLeg.status`, and the outbox-scan `status` query param. So in the broadcast `f3336606…`, `CommOutbox.status` wrongly emitted `enum:[…,null]` and the SDK typed it `… | null` — a value the API never sends. **B/C consuming `f3336606…` got `CommOutbox.status` as nullable; it is not.** Fixed (replace-don't-mutate + a 9-case unit spec `api/test/schema-hygiene.spec.ts` locking the shared-array case) and re-emitted. **New FINAL sha `097d9dc8a2a79a5fdeaf34c1bcd63a33fc7ab3a94c3c1dba2eef5397d2320797`** — please re-broadcast to B and C. Delta is strictly a NARROWING (status fields lose a spurious `| null`); no field/endpoint added or removed. Doc-wide sweep confirms zero remaining nullable-enum mismatches.

## Checklist
- [x] M0 ✅ — firewall relaxation + 17 comms contract stubs + spec/SDK emitted, all fast gates green
  - [x] Firewall: agent `kind='communication'` allowed IFF `approval_ref` + (`approved_by` OR `grant:`-prefixed ref); 403s kept for corrections and no-provenance free text; 17-branch vitest unit spec + integration cases updated
  - [x] All `/v1/accounts/{accountId}/comms/*` routes as typed zod-openapi stubs (501 `not_implemented` via standard envelope)
  - [x] Spec + SDK emitted; `check:drift`, `check:guide-drift`, lint, typecheck, unit tests, api build all green
- [x] M1 ✅ — migration `20260701000002_comms_ledger.sql`: all 9 tables (force-RLS, ADR-0003 member policies, `_emit_event` audit attachment, composite `(account_id,id)` uniques), `interactions.thread_id` + rebuilt `interactions_with_chain` (delivery join), capacity trigger resurrected + provenance-extended, RPCs `complete_send`/`capture_inbound`/`record_opt_out`/`list_account_opt_outs` (DEFINER, self-defending, allowlisted) + `fail_send`/`update_delivery`/`reconcile_scan` (INVOKER), opt-out enforcement as BEFORE-INSERT trigger, outbox state-machine guard trigger. Local: full migration chain + isolation (incl. meaningfulness) + audit + money + tenancy-status + definer-grants guard ALL GREEN.
- [x] M2 ✅ — all 17 endpoints implemented (RPCs + RLS-scoped queries; transport = agent principal, landlord = owner|manager, viewers 403). Provenance enforced on intent create (grant refs must name a LIVE `comm_policies` row of the account; landlord refs stamped `self:<uid>`); destination resolution explicit-address → thread binding → channel identity; opt-out surfaces as 422 `opted_out`; canonical `rent_reminder` params validated per INBOX (`{days_before, monthly_cap}`, unknown keys 400). Spec + SDK re-emitted; api-guide §8e added; firewall now also requires `external_ref` on agent communications app-side (announced; Plan B unaffected — always sends it).
- [x] M3 ✅ — `api/test/comms.test.ts` (24 checks, wired into CI integration job as `test:comms`): intent→claim→complete atomicity (journal appended EXACTLY once, only on confirmed send; replay idempotent), fail leaves NO journal row + terminal 409, needs_reconcile park/resolve, monotonic delivery (stale callbacks no-op), inbound matched/orphan/opted_out + provider_msg_id idempotency, opt-out parks queued intents + blocks new at the boundary + first-wins replay, thread detail w/ delivery state + message cursor paging, policy revoke parks grant sends + blocks new, reconcile scan, Idempotency-Key replay single-row, principal gating sweep, events-feed surfacing, cross-account 404s, binding partial-unique 409 + no-skeleton cleanup. Firewall unit spec (18 branches) + agent-principal suite updated. ALL local suites green: comms, agent-principal, interactions-journal, events-feed, api-isolation, db isolation/audit/money/tenancy/definer-guard, unit, build, lint, drift×2, service-role, admin-quarantine.

## Hardening review (post-ACK; all findings re-verified by me before fixing)
Two independent adversarial reviewers (one DB-focused, one API-focused); I checked every finding against source, kept the real ones, and dropped/deferred the rest with reasons. All fixes are in migration `…03_comms_ledger_hardening.sql` + `comms.ts`/`idempotency-contract.ts` patches; regression guards added.

DB (all reachable only via a member hitting PostgREST directly — RLS/triggers are the boundary):
- **F1 (HIGH, fixed) — agent author-type laundering.** `comm_outbox` had a `for all` member policy and no agent-capacity guard at INSERT, so an agent could directly insert `author_type='landlord'` and `complete_send` (DEFINER + the verified-write GUC that exempts `_enforce_agent_capacity`) would launder it into a HUMAN-attributed journal communication. The dropped predecessor's completion RPC was INVOKER so its trigger caught this; the DEFINER+GUC generalization dropped the shadow. Fix: BEFORE-INSERT capacity trigger forcing agent inserters to `author_type='agent'` (author_type is already immutable post-insert) + birth-status pinned to `queued`. Guard: raw-PostgREST forge test.
- **F2 (MED, fixed) — cross-account inbound dedupe.** `capture_inbound` replay/re-read keyed on the globally-unique `provider_msg_id` with no account filter → could return account B's cached ids or suppress B's real capture. Fix: stamp+pin `matched_account_id`; a msg id already held by another account raises 409, never leaks. Guard: cross-account capture test (agent transports both accounts).
- **F3/F4 (MED, fixed) — opt-out register metadata leak.** `keyword`/`source_ref` (a provider msg id from whoever first reported the opt-out) leaked cross-account via `list_account_opt_outs` (member-forgeable `channel_identities` intersection) and `record_opt_out` (echoed the pre-existing foreign row). The per-address boolean is inherent (a send attempt reveals it) — accepted; the recording metadata must not cross accounts. Fix: neither RPC returns `keyword`/`source_ref` for a row it didn't create this call. Guard: replay-metadata test updated.
- **F5 (MED, fixed) — cross-account routing DoS.** `thread_channel_bindings.platform_number` FK was to the global `platform_numbers(number)`, not the binding's account (FK check bypasses RLS), so a member could bind another account's number and occupy its global routing slot. Fix: composite FK `(account_id, platform_number)`. Guard: cross-account bind test.
- **F6 (LOW, partial) — state guard was UPDATE-only.** Added birth-status=`queued` enforcement (folded into the F1 trigger). DELETE/other-field UPDATE tightening deferred (own-account only; audit chain already records deletions).

API:
- **Finding 2 (HIGH, fixed)** = the contract corruption above.
- **Finding 3 (fixed)** — `createOutbox` grant validation now also requires the grant's `channel` to match the send's channel (an sms grant no longer authorizes voice/email).
- **Finding 4 (fixed)** — `complete`/`fail`/`delivery` handlers now pin the outbox row to the URL account before the RPC (clean 404 on divergence; RPCs previously self-defended on the row's OWN account only).
- **Finding 5 (fixed)** — `createOutbox` binding-resolved destination now runs through `normalizeAddress` (channel/format validated, not silently reused).
- **Finding 6 (fixed)** — `revokePolicy` concurrent double-revoke now stays idempotent (re-reads on lost race) instead of a spurious 500.
- **Finding 7 (fixed)** — `createThread` now refuses non-sms channels (501) — the message path is sms-only today, so accepting email/voice threads would mis-send. Schema still advertises the future channels.
- **Finding 8 (fixed)** — `is_approver_member` RPC errors are surfaced, not swallowed into a misleading 400.

Considered and NOT changed (with reasons):
- **Finding 1 (agent cites a nonexistent grant on the DIRECT `POST /interactions` path) — DEFERRED to you (Question 4).** That path RECORDS a send that already happened (Plan B's confirmed-send journal). Rejecting it because the cited grant is revoked/absent would suppress the record of a real send — an ADR-0007 violation ("a message is never sent without a record"). Grant validation is enforced at INTENT-CREATION on `/comms/outbox` instead. Also it's a behavior change on Plan B's active path, so per protocol I won't tighten it without your ack.
- Monthly-cap / quiet-hours enforcement, `thread_autonomy`/`voice_autonomy` params: tracked follow-ups (need counting infra / your canonical shapes).
- RPC role-vs-membership checks (`complete_send`/`list_account_opt_outs` check membership not role): documented-intentional in the definer-grant allowlist; consistent with the codebase's "RLS = tenant isolation; role = app-layer" model.

## Contract
- **FINAL spec** (corrected): `openapi/openapi.json` sha256 `097d9dc8a2a79a5fdeaf34c1bcd63a33fc7ab3a94c3c1dba2eef5397d2320797`. Supersedes `f3336606…` (which carried the `CommOutbox.status` nullability corruption — see ⚠️ CONTRACT). Content otherwise identical: the 3 INBOX re-emit items + `CommPolicy.quiet_hours` nullability restoration are all present; doc-wide sweep clean.
- Superseded shas: `f3336606…` (broadcast, corrupted status enums — DO NOT USE), M2-pre-hygiene `b0817547…`, M0 `215ac1e2…` (commit `520ed50`).
- **INBOX 2026-07-02 "M0 addition" — already satisfied in the sha above.** `CreateInteractionBody.external_ref` is writable exactly as requested: agent principal + fresh `kind='communication'` only (landlords 400 `invalid_request`; corrections/notes/agent_events 400 via shape validation). Firewall governs, per your "simplest" option.
- Endpoints: the full PLAN.md M0 list, plus **`GET /comms/outbox/{id}`** (added: the ADR-0007 "send_state_unknown" resolution read the transport needs after a lost complete/fail response; flag if unwanted).
- **`Interaction` gains `thread_id?: uuid|null`** (contract-first: column lands in M1; reads return null/absent until then).
- **`POST /interactions` gains optional agent-only `external_ref`** (kind='communication' only, landlords 400). Rationale: M1 resurrects the DB backstop *"agent-authored communications require external_ref"* — without a body field the direct agent journal path would be structurally dead post-M1. Optional at the app layer in M0; once the M1 trigger lands I intend to enforce it in the firewall too (clean 400 instead of DB error). **Coordinator: please confirm this matches landlord-agent/docs/agent-sends-core-records.md** (not readable from this repo).
- Provenance convention implemented exactly as specified: `proposal:<id>`+approved_by / `grant:<id>`+approved_by-null / `self:<user_id>` for landlord thread messages (stamped server-side, M2).

## Blockers
(none — proceeding to M1)

## Questions for coordinator
1. ~~`external_ref` on direct agent communications~~ — RESOLVED (INBOX ack; shipped in M0, firewall tightening landed with M2 as announced).
2. ~~`GET /comms/outbox/{id}`~~ — RESOLVED (INBOX: keep).
3. `thread_autonomy` / `voice_autonomy` policy `params` have no canonical shape yet — M2 passes them through unvalidated (only `rent_reminder` is strict per your INBOX note). Publish shapes when agreed and I'll tighten in a follow-up.
4. **Finding 1 (grant validation on the direct `POST /interactions` path).** Should an agent citing a `grant:<id>` when journaling a confirmed send be rejected if the policy doesn't exist / isn't ours? I did NOT enforce it (rejecting a revoked-since grant would suppress the record of a real send → ADR-0007 violation; and it changes behavior on Plan B's active path). If you want a nonexistent-grant guard here, I can validate EXISTENCE only (not active-status) once you confirm Plan B always emits a real `comm_policies` uuid in the grant ref. Your call.
4. Deploy sequencing reminder: migration `20260701000002_comms_ledger.sql` must be applied to prod BEFORE (or with) this branch's deploy — the M2 handlers and the rebuilt `interactions_with_chain` view depend on it. Also note the direct agent journal path stays enabled until you signal Plan B's M4, per your instruction.

## Events-feed entity_type strings (per INBOX ask — for the FE poller map)
`_emit_event` uses TG_TABLE_NAME verbatim, so the new audited tables emit exactly:
`comm_outbox`, `comm_threads`, `comm_thread_participants`, `channel_identities`, `platform_numbers`, `thread_channel_bindings`, `comm_policies`.
(`comm_opt_outs` and `inbound_raw` are deliberately NOT audited — no account_id; integrity via PK/UNIQUE. Delivery-state transitions arrive as `comm_outbox` `updated` events; journal appends as `interactions` `inserted` events, as today.)

## Design notes for B/C (final behavior)
- Transport flow: `GET /comms/outbox?status=queued&eligible_at=now` → `POST …/delivery {status:'sending'}` (claim) → dial provider → `POST …/complete {provider, provider_sid}` (or `…/fail`, `reconcile:true` when the outcome is unknown). Complete is idempotent on sid replay; complete works from `queued` directly too (claim recommended, not required).
- Opt-out enforcement is a BEFORE-INSERT trigger on comm_outbox → API 422 `error.code='opted_out'`: refused sends leave no journal trace. `record_opt_out` parks queued intents to that address as `undeliverable` (`error_code='opted_out'`) globally; `sending` rows are left for the provider to refuse. First opt-out wins; replays return the original row.
- Agent send intents under `approval_ref='grant:<id>'` are validated against a LIVE `comm_policies` row of that account (403 otherwise). Policy revoke parks its queued sends (`error_code='policy_revoked'`) and blocks new intents.
- Inbound: `disposition='opted_out'` means the message WAS journaled (the contact happened) but the transport must not relay/reply. `orphan` = raw-captured only, nothing journaled (no binding).
- Journal rows read via `/interactions*` and thread messages now expose derived `outbox_id` / `delivery_status` / `delivered_at` (chain-view join) and `thread_id`.

## Log
(newest first; one line per push: date, milestone, summary)
- 2026-07-02 HARDENING ✅: adversarial review → migration `…03` (F1 evidence-honesty + F2/F5 cross-account + F3/F4 opt-out leak) + 7 API fixes incl. the `injectSchemaHygiene` corruption that broke `CommOutbox.status` in the broadcast sha. New FINAL sha `097d9dc8…` — **needs re-broadcast**. All gates green (comms 34 checks + full DB suite + unit 67 + drift×2). Finding 1 deferred to coordinator (Q4).
- 2026-07-02 FINAL ACK received — Plan A complete; contract `f3336606…` broadcast to B/C. Post-ack hardening review in progress locally.
- 2026-07-02 contract-hygiene ✅: all 3 INBOX re-emit items + CommPolicy.quiet_hours nullability; FINAL spec sha `f3336606…`; suite re-verified green (and made re-runnable against a persistent stack).
- 2026-07-02 M2+M3 ✅ (commit `12c851b`): all 17 handlers live + 24-check integration suite wired into CI; every gate green. Definition of done reached pending coordinator ack.
- 2026-07-02 M1 ✅: comms ledger migration + guard-allowlist + seeds; full local DB suite green (isolation/audit/money/tenancy/definer-guard).
- 2026-07-01 M0 ✅: firewall provenance gate + 17 comms stub endpoints + spec/SDK; gates green; contract commit `d77528f`.
