# STATUS — worker-owned. Update + push after every milestone, blocker, or question.

## Current milestone
M1 — ledger migrations (starting)

## Checklist
- [x] M0 ✅ — firewall relaxation + 17 comms contract stubs + spec/SDK emitted, all fast gates green
  - [x] Firewall: agent `kind='communication'` allowed IFF `approval_ref` + (`approved_by` OR `grant:`-prefixed ref); 403s kept for corrections and no-provenance free text; 17-branch vitest unit spec + integration cases updated
  - [x] All `/v1/accounts/{accountId}/comms/*` routes as typed zod-openapi stubs (501 `not_implemented` via standard envelope)
  - [x] Spec + SDK emitted; `check:drift`, `check:guide-drift`, lint, typecheck, unit tests, api build all green
- [ ] M1 🔄 — comm_outbox / comm_opt_outs / inbound_raw / threads / participants / identities / platform_numbers / bindings / policies + RPCs + view
- [ ] M2 — real handlers
- [ ] M3 — tests + gates

## Contract
- **M0 spec committed**: see Log for commit sha. `openapi/openapi.json` sha256 will be recorded per commit below.
- Endpoints: the full PLAN.md M0 list, plus **`GET /comms/outbox/{id}`** (added: the ADR-0007 "send_state_unknown" resolution read the transport needs after a lost complete/fail response; flag if unwanted).
- **`Interaction` gains `thread_id?: uuid|null`** (contract-first: column lands in M1; reads return null/absent until then).
- **`POST /interactions` gains optional agent-only `external_ref`** (kind='communication' only, landlords 400). Rationale: M1 resurrects the DB backstop *"agent-authored communications require external_ref"* — without a body field the direct agent journal path would be structurally dead post-M1. Optional at the app layer in M0; once the M1 trigger lands I intend to enforce it in the firewall too (clean 400 instead of DB error). **Coordinator: please confirm this matches landlord-agent/docs/agent-sends-core-records.md** (not readable from this repo).
- Provenance convention implemented exactly as specified: `proposal:<id>`+approved_by / `grant:<id>`+approved_by-null / `self:<user_id>` for landlord thread messages (stamped server-side, M2).

## Blockers
(none — proceeding to M1)

## Questions for coordinator
1. `external_ref` on direct agent communications (see Contract above): confirm the M0 addition + planned M1 firewall tightening compose correctly with Plan B's design. If Plan B only ever writes communications via `POST /comms/outbox` → `/complete`, the direct-path field is harmless but unused.
2. `GET /comms/outbox/{id}` added beyond the PLAN list (transport recovery read). Say the word and I'll drop it before B/C consume.

## Log
(newest first; one line per push: date, milestone, summary)
- 2026-07-01 M0 ✅: firewall provenance gate + 17 comms stub endpoints + spec/SDK; gates green; spec sha in commit noted below.
