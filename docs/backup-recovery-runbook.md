# Backup & disaster-recovery runbook

Off-platform backup and restore for the rental CRM data spine. Target
architecture is **$0/month** on a public GitHub repo (free Actions minutes):
`pg_dump` every 15 minutes (48h retention) + a daily promoted dump (30d) +
a daily Storage-file sync, all landing in a Cloudflare R2 bucket (any
S3-compatible endpoint works). Supabase PITR was **deliberately not purchased**;
the paid upgrade paths are in the RPO/RTO table below.

System: Supabase Postgres 17 cloud project (ref `wywfplbylmpfafxyaqpq`,
`db/supabase/config.toml` `major_version = 17`); stateless API on Render
(`render.yaml`). Workflows: `.github/workflows/db-backup-15min.yml` and
`.github/workflows/db-backup-daily.yml`.

## 1. RPO/RTO summary

| Tier | RPO | RTO | Retention / notes |
|---|---|---|---|
| DB — 15-min | ≤15 min typical; worst case ~20–30 min when the GitHub cron drifts under load | ~1–2 h (fresh project + migrate + restore) | 48 h of 15-min snapshots under `pg/15min/` |
| DB — daily | 24 h | ~1–2 h | 30-day history under `pg/daily/` |
| Storage files | 24 h | included in DB RTO | Nightly sync only. An attachment uploaded **after** the last nightly sync is lost in a full-loss scenario **even though its `public.attachments` row survives** (see Restore §B). |

Paid upgrade paths, if a hard guarantee is ever required:

- **Supabase PITR add-on** — ~$130/mo total (Pro $25 + Small compute ~$5 net +
  PITR $100). ~2-minute granularity, in-platform, no restore choreography.
- **Render cron job** — ~$1–2/mo for drift-free 15-min scheduling (removes the
  GitHub-cron drift that pushes worst-case RPO to ~20–30 min). Keeps everything
  else in this doc unchanged; only the trigger moves off GitHub.

## 2. One-time setup checklist

> **Shortcut:** `scripts/setup-backups.sh` automates steps 3–5 (creates the
> `backup_reader` role, verifies the connection isn't the transaction pooler,
> pushes the 9 GitHub secrets via `gh`, and dispatches the workflows). Steps 1–2
> are dashboard-only and must be done first. Run `bash scripts/setup-backups.sh`
> for all stages, or a single stage: `role` | `secrets` | `verify`.

1. **Create the R2 bucket** (e.g. `rental-crm-backups`) and an API token
   **scoped to that bucket** with object read/write/**delete** — delete is
   required for the retention pruning in both workflows.

2. **Enable Supabase Storage S3 access keys**: Dashboard → Project Settings →
   Storage → S3 access keys. Note the endpoint
   `https://wywfplbylmpfafxyaqpq.storage.supabase.co/storage/v1/s3` and the
   **region** shown on that page (needed for the rclone sync).

3. **Create a dedicated read-only backup role** on the prod DB — separate from
   `SUPABASE_DB_URL`, which is the least-privilege *import* role and must not be
   reused for backups (see `.env.example` lines 14–24):
   ```sql
   create role backup_reader login password '<strong-random>';
   grant pg_read_all_data to backup_reader;
   -- pg_dump runs with row_security=off and aborts on RLS-enabled tables
   -- ("query would be affected by row-level security policy") unless the role
   -- bypasses RLS. pg_read_all_data grants SELECT but NOT RLS bypass, so:
   alter role backup_reader bypassrls;
   ```
   Then verify it can read `auth.users` / `auth.identities`:
   ```sql
   set role backup_reader;
   select count(*) from auth.users;      -- must not error
   select count(*) from auth.identities; -- must not error
   reset role;
   ```
   If either errors, the 15-min workflow's "Dump auth identities (best-effort)"
   step degrades to a `::warning::` and keeps the run green — the auth gap then
   applies (see Gotchas and Restore §A).

4. **Add the GitHub Actions repo secrets** (Settings → Secrets and variables →
   Actions). All 8 (+region) are required:

   | Secret | Value |
   |---|---|
   | `BACKUP_DB_URL` | `backup_reader` connection — use the **Session pooler** URL (host `aws-0-<region>.pooler.supabase.com`, port **5432**, username tenant-qualified as `backup_reader.<project_ref>`). **NOT** the direct host `db.<ref>.supabase.co` — Supabase serves it IPv6-only and GitHub runners have no IPv6, so it fails with *"Network is unreachable"*. **NOT** the transaction pooler (port 6543): `pg_dump` fails there. **Never** reuse `SUPABASE_DB_URL` (the least-privilege import role per `.env.example`). |
   | `BACKUP_S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
   | `BACKUP_S3_BUCKET` | e.g. `rental-crm-backups` |
   | `BACKUP_S3_ACCESS_KEY_ID` | R2 token key id |
   | `BACKUP_S3_SECRET_ACCESS_KEY` | R2 token secret |
   | `SUPABASE_STORAGE_S3_ENDPOINT` | `https://wywfplbylmpfafxyaqpq.storage.supabase.co/storage/v1/s3` |
   | `SUPABASE_STORAGE_S3_ACCESS_KEY_ID` | from step 2 |
   | `SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY` | from step 2 |
   | `SUPABASE_STORAGE_S3_REGION` | region shown in step 2 |

5. **First-run verification**:
   1. Actions → `db-backup-15min` → Run workflow. Confirm a `db-<stamp>.dump`
      lands under `pg/15min/` in the bucket (and `auth-<stamp>.dump` if the
      backup role can read the auth schema).
   2. Actions → `db-backup-daily` → Run workflow with **`verify_restore: true`**.
      Confirm promote (`pg/daily/`), Storage sync (`storage/`), and the
      restore-verify job all go green.

## 3. Restore procedure

Written for a 2am incident. The dumps are `--no-owner --no-privileges
--schema=public`, custom format, zstd-compressed. **Roles, grants, RLS,
triggers, and extensions do NOT come from the dump — they come from the
migrations** in `db/supabase/migrations`. Always apply migrations first.

### A. Same project, bad data (accidental delete / corruption)

Restore into a **fresh Supabase project** and cut over (safest), or restore
specific tables in place. General path for a full restore:

1. **Create a new PG-17 Supabase project.** Grab its direct DB URL as
   `$NEW_DB_URL` (port 5432 — not 6543).

2. **Apply migrations first** from the source of truth:
   ```sh
   cd db && supabase db push --db-url "$NEW_DB_URL"
   ```
   This rebuilds schema, roles/grants, RLS, triggers, and extensions. The dump
   carries none of these.

3. **Pull the dump** you want from the bucket:
   ```sh
   aws s3 cp "s3://$S3_BUCKET/pg/15min/db-<stamp>.dump" . \
     --endpoint-url "$BACKUP_S3_ENDPOINT"   # or pg/daily/ for the 30d tier
   ```

4. **Data-only restore.** Run this **as the `postgres` role of the new project**
   (it owns the tables, which `--disable-triggers` requires). If any migration
   seeds rows, truncate the public tables first so COPY doesn't hit duplicate
   keys:
   ```sql
   do $$ declare r record; begin
     for r in (select tablename from pg_tables where schemaname='public') loop
       execute format('truncate table public.%I restart identity cascade', r.tablename);
     end loop;
   end $$;
   ```
   ```sh
   pg_restore --data-only --disable-triggers \
     --no-owner --no-privileges -j 4 \
     -d "$NEW_DB_URL" db-<stamp>.dump
   ```
   `--disable-triggers` needs table ownership. Migrations were applied as the
   new project's `postgres` role (step 2), so that role owns every table —
   use its connection string for the restore and ownership is satisfied. If
   `--disable-triggers` still errors, restore single-session with triggers
   suppressed via the replica setting instead (slower, same effect):
   ```sh
   pg_restore --data-only --no-owner --no-privileges -f - db-<stamp>.dump \
     | psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 \
         -c "set session_replication_role = replica;" -f -
   ```
   Suppressing triggers matters because the audit-chain tables are
   trigger-maintained; re-firing them on insert would rewrite the chain.

5. **Verify the audit chain** rather than trusting re-fired triggers. Per
   account:
   ```sql
   select * from public.verify_chain('<account-uuid>');
   -- or sweep-and-alert:
   select * from public.verify_chain_sweep('<account-uuid>');
   ```
   See the Phase-11 migration
   `db/supabase/migrations/20260605000012_phase11_chain_sweep_and_janitors.sql`.

6. **Restore auth identities** if `auth-<stamp>.dump` exists (it may not — see
   Gotchas):
   ```sh
   aws s3 cp "s3://$S3_BUCKET/pg/15min/auth-<stamp>.dump" . \
     --endpoint-url "$BACKUP_S3_ENDPOINT"
   pg_restore --data-only --no-owner --no-privileges \
     -d "$NEW_DB_URL" auth-<stamp>.dump      # auth.users + auth.identities
   ```
   If no auth dump exists, human users re-register / are re-provisioned, and
   **agent service accounts are re-creatable** via the agent-grant flow
   (`docs/agent-runbook.md`).

### B. Storage files

Reverse the daily sync — pull the backed-up files back into the **new**
project's Storage over the S3 protocol (Supabase re-indexes S3-uploaded objects
into `storage.objects` automatically). Configure two rclone remotes the same
env-var way the daily workflow does (`RCLONE_CONFIG_<NAME>_<KEY>`), but with
`BAK` = the R2 backup bucket and `NEWPROJ` = the **new** project's Storage S3
endpoint + keys + region (setup step 2), then:
```sh
rclone sync "bak:<bucket>/storage" newproj: --checksum --transfers 8
```
Today the only bucket is `attachments`; syncing to the remote root restores
every bucket that was backed up.

### C. Cut over the app

1. Update Render env vars to the new project: `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.
2. Re-create the **least-privilege import role** for `SUPABASE_DB_URL` per the
   `.env.example` notes (dedicated login, not superuser, able to
   `SET ROLE service_role`), and re-create the `backup_reader` role (setup §3).
3. Re-add the PG-level GitHub secrets that point at the new project
   (`BACKUP_DB_URL`; Storage S3 secrets if the endpoint changed).
4. Smoke-check `GET /healthz` and one authenticated account-scoped request.

## 4. Gotchas

- **Transaction pooler is incompatible.** `pg_dump`/`pg_restore` fail on the
  transaction pooler (port 6543). Use a direct 5432 or session-pooler URL for
  `BACKUP_DB_URL` and `$NEW_DB_URL`.
- **`pg_dump` client major must be ≥ server major.** `ubuntu-latest` ships
  client 16; the server is PG 17. Both workflows have a PGDG install step that
  pins `postgresql-client-17`. When you bump the server major, bump that step
  **and** `db/supabase/config.toml` `major_version` together.
- **Auth-schema readability is best-effort.** If `backup_reader` cannot read
  `auth.users` / `auth.identities`, the auth dump step warns and the run stays
  green — but no `auth-<stamp>.dump` is produced, so login identities are not
  recoverable from backup (see Restore §A step 6).
- **GitHub disables scheduled workflows after 60 days of no repo activity** on
  public repos. The Actions tab shows a re-enable banner — re-enable it and
  manually dispatch `db-backup-15min` once to backfill the gap.
- **GitHub cron drifts** under load; that is why worst-case RPO is ~20–30 min,
  not a hard 15. The Render-cron upgrade path (§1) removes this.
- **R2 free tier is 10 GB.** The 48h/30d pruning keeps a small CRM well under
  it, but check bucket size if the DB grows.

## 5. Quarterly restore test

Run every quarter and log the outcome below.

1. Actions → `db-backup-daily` → Run workflow with **`verify_restore: true`**.
2. Confirm the run is green. The verify job rehearses the real recovery in a
   scratch `postgres:17` container (migrations first, then data-only restore)
   and asserts restored rows > 0 **and a clean `verify_chain()` for every
   account** — so a green run means the evidence trail survived
   dump→restore intact. Row counts are printed in the job log for eyeballing.
3. Spot-check one attachment: pick a `public.attachments.storage_path` row and
   confirm the matching object exists under `storage/attachments/…` in the
   backup bucket.
4. Record the date and outcome in the table below.

| Date | Ran by | Result | Notes |
|---|---|---|---|
| | | | |
