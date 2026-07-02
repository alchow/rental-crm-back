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
- **M0 spec committed**: commit `520ed50` (sha corrected after rebase onto the INBOX update); `openapi/openapi.json` sha256 `215ac1e26be4aef920f67c6752f63d61f0cecd6288e2053514ca945aba476139`. Broadcast to Plans B/C at will — schemas are final; handlers 501 until M2.
- **INBOX 2026-07-02 "M0 addition" — already satisfied in the sha above.** `CreateInteractionBody.external_ref` is writable exactly as requested: agent principal + fresh `kind='communication'` only (landlords 400 `invalid_request`; corrections/notes/agent_events 400 via shape validation). Firewall governs, per your "simplest" option.
- Endpoints: the full PLAN.md M0 list, plus **`GET /comms/outbox/{id}`** (added: the ADR-0007 "send_state_unknown" resolution read the transport needs after a lost complete/fail response; flag if unwanted).
- **`Interaction` gains `thread_id?: uuid|null`** (contract-first: column lands in M1; reads return null/absent until then).
- **`POST /interactions` gains optional agent-only `external_ref`** (kind='communication' only, landlords 400). Rationale: M1 resurrects the DB backstop *"agent-authored communications require external_ref"* — without a body field the direct agent journal path would be structurally dead post-M1. Optional at the app layer in M0; once the M1 trigger lands I intend to enforce it in the firewall too (clean 400 instead of DB error). **Coordinator: please confirm this matches landlord-agent/docs/agent-sends-core-records.md** (not readable from this repo).
- Provenance convention implemented exactly as specified: `proposal:<id>`+approved_by / `grant:<id>`+approved_by-null / `self:<user_id>` for landlord thread messages (stamped server-side, M2).

## Blockers
(none — proceeding to M1)

## Questions for coordinator
1. ~~`external_ref` on direct agent communications~~ — RESOLVED by INBOX "M0 addition" (requirement matched what shipped; nothing to change).
2. `GET /comms/outbox/{id}` added beyond the PLAN list (transport recovery read). Say the word and I'll drop it before B/C consume.
3. Heads-up for the M1 announcement: once the capacity trigger lands I plan to ALSO require `external_ref` app-side in the firewall for agent communications (clean 400 instead of a DB check_violation surfacing as 500). Additive tightening, no schema change; will note in STATUS when it lands.

## Log
(newest first; one line per push: date, milestone, summary)
- 2026-07-01 M0 ✅: firewall provenance gate + 17 comms stub endpoints + spec/SDK; gates green; contract commit `d77528f`.
