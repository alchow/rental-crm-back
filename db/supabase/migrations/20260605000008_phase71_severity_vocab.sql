-- ----------------------------------------------------------------------------
-- Phase 7.1: maintenance_requests.severity vocabulary.
--
-- The Phase 2 schema used [low, medium, high, urgent] -- generic priorities.
-- The review's preferred vocabulary is [emergency, urgent, routine] --
-- triage-actionable categories that map to the habitability-emergency
-- record landlords actually need:
--   emergency = drop everything (hot water out in winter, flood, gas)
--   urgent    = today/tomorrow (broken lock, stove out)
--   routine   = schedule (squeaky hinge, cosmetic)
--
-- Remap existing rows:
--   'low'    -> 'routine'   (lower bands collapse to routine)
--   'medium' -> 'routine'
--   'high'   -> 'urgent'    (high but not "drop everything" -> urgent)
--   'urgent' -> 'emergency' (the prior top tier IS the emergency band)
--
-- The remap is conservative: it never DOWNGRADES a severity (a 'high'
-- becomes 'urgent', not 'routine'), and it puts the most acute prior bucket
-- into the new 'emergency' band.
-- ----------------------------------------------------------------------------

-- Drop the existing constraint (auto-named; located by definition).
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.maintenance_requests'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%severity%'
  loop
    execute format('alter table public.maintenance_requests drop constraint %I', c);
  end loop;
end $$;

-- Remap existing rows.
update public.maintenance_requests set severity = 'routine'   where severity in ('low', 'medium');
update public.maintenance_requests set severity = 'emergency' where severity = 'urgent';
update public.maintenance_requests set severity = 'urgent'    where severity = 'high';

-- New constraint.
alter table public.maintenance_requests
  add constraint maintenance_requests_severity_check
  check (severity in ('emergency', 'urgent', 'routine'));
