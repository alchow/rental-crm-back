-- ----------------------------------------------------------------------------
-- Intake tokens: lifetime successful-submission counter.
--
-- Distinct from use_count, which is the 10-minute sliding rate-limit window
-- state: use_count is bumped on ATTEMPT (before body validation, so failed
-- submissions count -- that is the point of a rate limiter) and RESETS each
-- window. The FE rendered use_count as a lifetime "Used N×" figure, which it
-- has never been (usability finding C2).
--
-- submission_count increments only after the intake RPC commits, from the API
-- handler via read-modify-write. It is a UX counter, not evidence, and it can
-- UNDERCOUNT: a crash between the RPC commit and the counter UPDATE loses one,
-- and N truly-concurrent submissions on the same link can collapse to a single
-- increment (bounded by the 20-per-window token rate limit). The
-- maintenance_request + interaction rows remain the auditable record of what
-- was actually submitted; never treat this counter as evidence.
-- ----------------------------------------------------------------------------

alter table public.intake_tokens
  add column submission_count int not null default 0;

comment on column public.intake_tokens.submission_count is
  'Lifetime count of successful submissions through this token (UX counter, bumped post-commit by the API).';
comment on column public.intake_tokens.use_count is
  'Rate-limit state: attempts in the current 10-minute sliding window (resets per window; failed attempts count).';
