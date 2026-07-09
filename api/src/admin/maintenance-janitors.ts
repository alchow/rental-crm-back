import { getLogger } from '../log';
import { ApiError } from '../routes/_lib/error';
import { getAdminClient } from './supabase-admin';

const ACCOUNT_PAGE = 1000;

interface AccountRow {
  id: string;
}

interface IdempotencyPruneRow {
  pruned_completed: number;
  pruned_in_flight: number;
}

interface ChainSweepRow {
  ok: boolean;
  alert_inserted: boolean;
  alerts_resolved: number;
}

export interface MaintenanceJanitorResult {
  tenancies_advanced: number;
  inbound_raw_pruned: number;
  idempotency_pruned_completed: number;
  idempotency_pruned_in_flight: number;
  ip_rate_buckets_pruned: number;
  accounts_scanned: number;
  chain_alerts_inserted: number;
  chain_alerts_resolved: number;
  chain_broken_accounts: number;
  failures: number;
}

async function enumerateAccountIds(admin: ReturnType<typeof getAdminClient>): Promise<AccountRow[]> {
  const accounts: AccountRow[] = [];
  for (let from = 0; ; from += ACCOUNT_PAGE) {
    const { data, error } = await admin
      .from('accounts')
      .select('id')
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, from + ACCOUNT_PAGE - 1);
    if (error) {
      throw new ApiError(500, 'database_error', `account scan failed: ${error.message}`);
    }
    const page = (data ?? []) as AccountRow[];
    accounts.push(...page);
    if (page.length < ACCOUNT_PAGE) break;
  }
  return accounts;
}

export async function runMaintenanceJanitors(): Promise<MaintenanceJanitorResult> {
  const log = getLogger();
  const admin = getAdminClient();
  const result: MaintenanceJanitorResult = {
    tenancies_advanced: 0,
    inbound_raw_pruned: 0,
    idempotency_pruned_completed: 0,
    idempotency_pruned_in_flight: 0,
    ip_rate_buckets_pruned: 0,
    accounts_scanned: 0,
    chain_alerts_inserted: 0,
    chain_alerts_resolved: 0,
    chain_broken_accounts: 0,
    failures: 0,
  };

  const advanced = await admin.rpc('advance_tenancy_statuses');
  if (advanced.error) {
    throw new ApiError(500, 'database_error', `advance_tenancy_statuses failed: ${advanced.error.message}`);
  }
  result.tenancies_advanced = ((advanced.data as unknown[] | null) ?? []).length;

  const inbound = await admin.rpc('prune_inbound_raw');
  if (inbound.error) {
    throw new ApiError(500, 'database_error', `prune_inbound_raw failed: ${inbound.error.message}`);
  }
  result.inbound_raw_pruned = Number(inbound.data ?? 0);

  const idempotency = await admin.rpc('prune_idempotency_keys');
  if (idempotency.error) {
    throw new ApiError(500, 'database_error', `prune_idempotency_keys failed: ${idempotency.error.message}`);
  }
  const idemRow = ((idempotency.data as IdempotencyPruneRow[] | null) ?? [])[0];
  result.idempotency_pruned_completed = idemRow?.pruned_completed ?? 0;
  result.idempotency_pruned_in_flight = idemRow?.pruned_in_flight ?? 0;

  const ipBuckets = await admin.rpc('prune_ip_rate_buckets');
  if (ipBuckets.error) {
    throw new ApiError(500, 'database_error', `prune_ip_rate_buckets failed: ${ipBuckets.error.message}`);
  }
  result.ip_rate_buckets_pruned = Number(ipBuckets.data ?? 0);

  const accounts = await enumerateAccountIds(admin);
  result.accounts_scanned = accounts.length;
  for (const { id: accountId } of accounts) {
    const { data, error } = await admin.rpc('verify_chain_sweep', { p_account_id: accountId });
    if (error) {
      result.failures += 1;
      log.error(
        { event: 'chain_sweep_account_failed', account_id: accountId, err: error.message },
        'audit-chain sweep failed for account',
      );
      continue;
    }
    const row = ((data as ChainSweepRow[] | null) ?? [])[0];
    if (!row) {
      result.failures += 1;
      log.error(
        { event: 'chain_sweep_account_empty', account_id: accountId },
        'audit-chain sweep returned no row',
      );
      continue;
    }
    if (!row.ok) result.chain_broken_accounts += 1;
    if (row.alert_inserted) result.chain_alerts_inserted += 1;
    result.chain_alerts_resolved += row.alerts_resolved;
  }

  log.info({ event: 'maintenance_janitors_done', ...result }, 'maintenance janitor pass');
  return result;
}
