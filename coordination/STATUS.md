# STATUS — worker-owned. Update + push after every milestone, blocker, or question.

## Current milestone
ALL MILESTONES COMPLETE — awaiting coordinator ack of the final contract sha

## Checklist
- [x] M0 ✅ — firewall relaxation + 17 comms contract stubs + spec/SDK emitted, all fast gates green
  - [x] Firewall: agent `kind='communication'` allowed IFF `approval_ref` + (`approved_by` OR `grant:`-prefixed ref); 403s kept for corrections and no-provenance free text; 17-branch vitest unit spec + integration cases updated
  - [x] All `/v1/accounts/{accountId}/comms/*` routes as typed zod-openapi stubs (501 `not_implemented` via standard envelope)
  - [x] Spec + SDK emitted; `check:drift`, `check:guide-drift`, lint, typecheck, unit tests, api build all green
- [x] M1 ✅ — migration `20260701000002_comms_ledger.sql`: all 9 tables (force-RLS, ADR-0003 member policies, `_emit_event` audit attachment, composite `(account_id,id)` uniques), `interactions.thread_id` + rebuilt `interactions_with_chain` (delivery join), capacity trigger resurrected + provenance-extended, RPCs `complete_send`/`capture_inbound`/`record_opt_out`/`list_account_opt_outs` (DEFINER, self-defending, allowlisted) + `fail_send`/`update_delivery`/`reconcile_scan` (INVOKER), opt-out enforcement as BEFORE-INSERT trigger, outbox state-machine guard trigger. Local: full migration chain + isolation (incl. meaningfulness) + audit + money + tenancy-status + definer-grants guard ALL GREEN.
- [x] M2 ✅ — all 17 endpoints implemented (RPCs + RLS-scoped queries; transport = agent principal, landlord = owner|manager, viewers 403). Provenance enforced on intent create (grant refs must name a LIVE `comm_policies` row of the account; landlord refs stamped `self:<uid>`); destination resolution explicit-address → thread binding → channel identity; opt-out surfaces as 422 `opted_out`; canonical `rent_reminder` params validated per INBOX (`{days_before, monthly_cap}`, unknown keys 400). Spec + SDK re-emitted; api-guide §8e added; firewall now also requires `external_ref` on agent communications app-side (announced; Plan B unaffected — always sends it).
- [x] M3 ✅ — `api/test/comms.test.ts` (24 checks, wired into CI integration job as `test:comms`): intent→claim→complete atomicity (journal appended EXACTLY once, only on confirmed send; replay idempotent), fail leaves NO journal row + terminal 409, needs_reconcile park/resolve, monotonic delivery (stale callbacks no-op), inbound matched/orphan/opted_out + provider_msg_id idempotency, opt-out parks queued intents + blocks new at the boundary + first-wins replay, thread detail w/ delivery state + message cursor paging, policy revoke parks grant sends + blocks new, reconcile scan, Idempotency-Key replay single-row, principal gating sweep, events-feed surfacing, cross-account 404s, binding partial-unique 409 + no-skeleton cleanup. Firewall unit spec (18 branches) + agent-principal suite updated. ALL local suites green: comms, agent-principal, interactions-journal, events-feed, api-isolation, db isolation/audit/money/tenancy/definer-guard, unit, build, lint, drift×2, service-role, admin-quarantine.

## Contract
- **FINAL spec**: `openapi/openapi.json` sha256 `f3336606dbc060051c36e5e048aab3e97d68811c3aa9300657f4548923435091`. All THREE INBOX re-emit items are in: (1) `'sending'` in `CommDeliveryBody`; (2) `CreateCommPolicyBody.quiet_hours` is a plain `$ref` (no allOf junk); (3) null added to the `Interaction.entry_type` / `Interaction.correction_kind` / `PatchInspectionItemBody.change_type` enums. Items 2+3 are fixed GENERICALLY via a new `injectSchemaHygiene` pass shared by the emitter and the runtime `/openapi.json` (so the class of bug can't recur), and a doc-wide sweep reports zero remaining instances. Bonus fix of the same family: `CommPolicy.quiet_hours` had silently LOST its nullability (bare `$ref`) — now `anyOf: [$ref CommQuietHours, null]`, so strict validators accept rows with no quiet hours. Handlers are LIVE — no more 501s.
- Superseded shas: M2-pre-hygiene `b0817547…` (never broadcast), M0 `215ac1e2…` (commit `520ed50`).
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
- 2026-07-02 contract-hygiene ✅: all 3 INBOX re-emit items + CommPolicy.quiet_hours nullability; FINAL spec sha `f3336606…`; suite re-verified green (and made re-runnable against a persistent stack).
- 2026-07-02 M2+M3 ✅ (commit `12c851b`): all 17 handlers live + 24-check integration suite wired into CI; every gate green. Definition of done reached pending coordinator ack.
- 2026-07-02 M1 ✅: comms ledger migration + guard-allowlist + seeds; full local DB suite green (isolation/audit/money/tenancy/definer-guard).
- 2026-07-01 M0 ✅: firewall provenance gate + 17 comms stub endpoints + spec/SDK; gates green; contract commit `d77528f`.
