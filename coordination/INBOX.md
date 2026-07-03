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

## 2026-07-02 — MERGED TO MAIN. Verify the live deploy from your side.

PR #49 merged (main = 32c24dc); prod migrations were applied beforehand.
Render should be auto-deploying main now. My sandbox egress cannot reach
rental-crm-api.onrender.com (proxy policy), so LIVE VERIFICATION falls to
you: once Render finishes, run from your machine:
`curl -s https://rental-crm-api.onrender.com/openapi.json | sha256sum`
— expect `7143b97f…` (the frozen contract sha; the served spec is
byte-identical to the committed one by design), and spot-check that
`/comms/outbox` paths are present. Report the result in STATUS (this is
the deploy's definition of done). If the sha differs or Render hasn't
deployed within ~15 min, say so — the human may need to check the Render
dashboard for a stuck/failed deploy.

## 2026-07-02 — Perf batch APPROVED. But live-deploy verification comes FIRST.

The …05 perf/retention migration is reviewed and approved — (A)/(B) fix
real hot-path scans, (C) is correct (composite unique subsumes them), and
the (D) rationale (never prune audit-attached tables; janitor for the
unaudited raw table only) is exactly right. Sequencing:
1. **FIRST: the live-deploy verification from my previous note is still
   pending** — curl the live /openapi.json, confirm sha `7143b97f…` and
   /comms paths, report in STATUS. Everything else waits on knowing main's
   deploy is actually serving.
2. Then the human applies …05 (one more `migrate:up` — index/janitor only,
   safe with the deployed code, no contract change).
3. Then I open and merge the follow-up PR for the …05 commit(s). Do not
   merge yourself.
4. Ops note recorded: `cron.schedule('prune-inbound-raw', …)` is a human
   step — I'm adding it to the enablement checklist alongside platform
   numbers, transport flags, and the Telnyx STOP check.

## 2026-07-02 — Live verification ACCEPTED. Deploy DoD met. Next: …05 sequence.

The pretty-vs-minified sha analysis is exactly the right kind of
verification — accepted, and the raw live sha is recorded. Bridged comms
is live (dormant pending enablement). Remaining sequence for the perf
batch: the human applies …05 (`migrate:up`, safe anytime), then I open and
merge the follow-up PR for your post-merge commits. I've relayed the GO to
the frontend for its live pass. Nothing else from you until the …05
migration is confirmed.

## 2026-07-02 — WORK ITEM GM-A: native group-MMS threads (core side)

Human-approved fast-follow. Verified Telnyx facts you design against:
group MMS on US/CAN long codes only, ≤8 participants, v2 API/webhooks;
inbound group messages hit our number with a `cc` array of the other
participants; outbound group send = one API call, per-recipient records
correlated by `group_message_id`; MMS delivery receipts unreliable
(Telnyx-to-Telnyx only).

Design (contract-first again — emit early, announce sha in STATUS):
1. `comm_threads.mode: 'bridged'|'group'` (default bridged; additive).
   `CreateCommThreadBody.mode` optional; `CommThread` response exposes it.
   Group mode: sms only, ≤7 human participants (8 incl. our number); the
   landlord participant's address IS a group member (bind it).
2. Bindings: keep per-participant rows. The (platform_number,
   participant_address) WHERE active partial-unique applies to BRIDGED
   bindings only (group bindings excluded via mode); instead enforce
   per-number GROUP-SET uniqueness (no two active group threads on one
   number with the identical human participant set) in the create path.
3. `capture_inbound` gains optional `cc: text[]`: when present, resolve by
   participant-set match (from + cc minus our number == a group thread's
   bound addresses on that number) → journal once with thread_id;
   no set match → orphan. 1:1 messages (no cc) keep the existing binding
   resolution — both modes coexist on one number.
4. Group outbound: ONE outbox row per group send — no per-recipient legs,
   no relay concept in group mode. `provider_sid` stores the
   group_message_id; `to_address` nullable for group rows (recipients
   derived from the thread). complete_send journals once (non-relay path,
   thread context) — unchanged code path should mostly cover it; verify.
5. STOP compliance rule for groups (hard requirement): a group MMS from
   our number reaches EVERY member, so an opt-out by ANY member blocks ALL
   system sends into that group (intent create → 422; queued group rows to
   that thread park). Inbound stays captured (evidence). Landlord sees why
   in the thread (frontend renders the parked state).
6. Spec: additive only. Emit + announce sha; B and C consume.
Gates as usual; tests: set-match capture (incl. orphan + cross-account),
group-set uniqueness, group send journal-once, any-member opt-out block.
Sequencing: independent of the …05 prod apply; same branch; I merge via PR
when the full GM batch (A+B+C) is verified.

## 2026-07-03 — GO GM-A NOW (explicit)

Clean state-sync from the fresh session — well done. To remove all
ambiguity: **GM-A is GO, start now.** It needs no further human approval
(the human approved the group-MMS fast-follow explicitly) and is
independent of the …05 prod apply, which stays with the human. Contract
first: emit the additive spec early and record the sha in STATUS so B and
C can start. Leaving the two stray untracked files uncommitted was right.

## 2026-07-03 — TRACKED (future email-channel work item): mailer migrate-and-delete

No action now — recording scope for when the email channel ships (queued
behind the GM batch). The email-channel work item, when dispatched, MUST
include on the core side:
1. Migrate the inspection-capture renewal email (the mailer's ONLY
   caller) onto the comms pipeline — outbox intent → transport email
   provider → confirmed-send journal record, gaining opt-out/delivery
   handling like every other send.
2. Delete `api/src/admin/mailer.ts` (port + Resend driver + stub) and
   drop `RESEND_API_KEY`/`MAIL_FROM` from core's render.yaml/env.
3. Result: "core never calls a provider" becomes literally true — the
   mailer is the last exception.
(Agent side gets the matching item then: email Provider driver behind the
transport port + inbound reply parsing.)

## 2026-07-03 — GM-A VERIFIED + all six decisions RATIFIED. Sha broadcast.

Independently verified `304e32c2…`: exactly the four additive fields, no
removals, paths unchanged, both hygiene sweeps clean. Decision rulings:
all six are ratified — in particular, the DB-enforced canonical
routing-key uniqueness is BETTER than what I directed; keeping it internal
is right; party_label-as-dialed-set is the honest attribution; including
the landlord's line in the send set is correct provider semantics; the
404-vs-400 nuance is acceptable (and arguably more correct — relayed to
B); rejecting 1:1 side-sends inside group threads is the right evidence
call. Sequencing answer: ONE prod `migrate:up` applying …05 + the GM-A
migration together is APPROVED (both expand-only, both safe ahead of the
code deploy) — no separate applies needed; that stays with the human.
GM-A is done; stand by while B and C build. I merge the full GM batch via
PR when all three verify.

## 2026-07-03 — PR #50 MERGED (main b90895b). Post-deploy verification, please.

The human confirmed the …05 + GM-A migrations were applied to prod before
this merge. Once Render finishes deploying main: verify from your machine
(1) live `/openapi.json` == the GM contract `304e32c2…` (semantic
comparison; raw sha will differ by minification as before), and
(2) note in STATUS that the deploy serves. The frontend worker is doing
the authenticated structural check (a live threads read exercises the new
`mode` column). Report in STATUS; if anything 500s, the immediate fix is
applying the migrations (human) — say so loudly.

## 2026-07-03 — WORK ITEM E1-A: email channel, slice 1 (send-only) — core side. GO now.

Human-approved. Provider is Resend for BOTH directions (verified: inbound
receiving with signed webhooks + stored-mail Receiving API exists) — but
slice 1 is SEND-ONLY; inbound/threads is slice 2, held. Core scope:
1. **Contract additions (additive, one emit, announce sha):** optional
   `subject` on CreateCommOutboxBody + comm_outbox (email-only semantics;
   400 on sms rows). Journal rule: complete_send for email rows records
   the FULL content honestly (document your chosen shape — e.g. body
   prefixed "Subject: …" — in STATUS so B renders templates to match).
2. **Provenance extension for core-originated transactional sends:**
   the inspection-capture renewal email migrates onto the pipeline as an
   outbox intent CREATED BY CORE (core writing its own ledger is not
   "core sends" — the transport still dials). It needs an honest
   provenance class: extend the CHECK/firewall with
   `approval_ref='system:<flow>'` valid ONLY for core-server-originated
   intents (never accepted from the agent principal or landlords over the
   API — enforce that). The renewal email thereby gains a journal record
   it never had.
3. **Unsubscribe (CAN-SPAM + Gmail/Yahoo one-click):** unauthenticated
   endpoint following the intake magic-link pattern that registers
   `record_opt_out(channel='email', address)` + a minimal confirmation
   page. Mechanism requirement: the TRANSPORT must be able to mint
   per-address unsubscribe URLs without a per-send round trip (stateless
   HMAC over the address with a shared secret is acceptable — document
   the exact format in STATUS for B), and it must support RFC 8058
   one-click (POST) for the List-Unsubscribe-Post header.
4. **Mailer migrate-and-delete (tracked scope, now live):** cut the
   inspection renewal over to the pipeline BEHIND a config flag or
   fallback (the old mailer path stays until B's email driver is verified
   live — do not break the renewal flow in the gap), then delete
   `api/src/admin/mailer.ts` + the RESEND/MAIL_FROM env from core when I
   signal cutover-verified.
Tests + gates per house standard; announce the new sha in STATUS.

## 2026-07-03 — E1-A VERIFIED + broadcast. Both flagged items APPROVED.

Independently verified `d6adb2b9…`: delta is exactly as you enumerated
(one new path, subject fields, UnsubscribeResponse, author_type widening,
scan channel param), hygiene sweeps clean. Rulings:
1. **author_type widening: APPROVED** — pre-empting the spec-vs-served
   class before the flag flip is exactly the lesson applied; B and C are
   being told to handle 'system' on re-pin.
2. **Scan channel filter: APPROVED** — B asked for per-channel loops;
   server-side scoping is right.
The `Subject:` journal shape, token format v1, and provenance pairing all
read correct. Enablement checklist additions recorded for the human:
UNSUBSCRIBE_HMAC_SECRET (same value, both services), COMMS_EMAIL_PIPELINE
stays OFF until B's driver is verified live, E1-A migration joins the
next prod migrate:up. E1-A is DONE — stand by; mailer deletion still
waits on my cutover-verified signal.

## 2026-07-03 — WORK ITEM E2-A: email inbound + email threads — core side. GO now.

Human-approved slice 2. Key design fact: email needs no shared-number
disambiguation — mint a UNIQUE tokenized reply address PER (thread,
participant) (e.g. `t-<token>@<receiving-domain>`), so BOTH tenant and
landlord reply natively from their own inboxes; routing is by the token,
never content. Scope:
1. **Bridged email threads**: lift the email 501 on thread creation for
   mode='bridged' (group email stays 501 — future). Landlord participant
   address = their account email. At creation, mint per-participant reply
   tokens; store so inbound (to-token) resolves (thread, participant)
   directly. The bindings table's uniqueness semantics must hold for
   email without colliding with SMS rows — mechanics your call (reuse
   platform_number column channel-aware, or a dedicated column);
   document for B. Receiving domain is global config (env), not
   per-account.
2. **capture_inbound for email**: channel='email', from_address = sender
   email (trim+lowercase), token-address resolution → (thread,
   participant). Defense: if the from-address doesn't match the bound
   participant's known address, journal as the thread's inbound but flag
   dishonest-sender risk your way (orphan vs annotate — your call,
   document). No cc semantics for email v1.
3. **Relay**: existing relay machinery applies (relay legs as email
   intents; relay-leg completion already links the original — no schema
   change expected). Subject threading: thread carries a subject seed
   ("Re: " continuation is B's rendering concern; if you need a thread
   subject column, it's additive).
4. **Spec**: expose whatever B/C need to render (e.g. participant reply
   addresses on thread detail if useful for FE copy). Keep additive; emit
   + announce sha in STATUS with the token/binding mechanics documented
   for B.
Tests per house standard (token resolution incl. cross-account pinning,
email relay journal-once via existing rules, sender-mismatch handling,
sms/email binding coexistence).
