// ----------------------------------------------------------------------------
// rentalcrm reference CLI
// ----------------------------------------------------------------------------
//
// Walks the full product flow against a running API using ONLY the generated
// SDK. This is the swappable-front-end proof: if this walk succeeds against
// the deployed contract, any other client (a web UI, a mobile app, a
// scripted batch tool) can do the same thing the same way.
//
//   signup
//     -> property + area (a unit)
//     -> tenancy
//     -> rent_schedule + an initial charge
//     -> partial payment (allocated, deliberately leaving a balance)
//     -> maintenance request + an interaction
//     -> inspection + items + complete (auto-renders the report PDF)
//     -> evidence export (the killer artifact)
//
// Inputs come from environment variables so the same script runs against
// local dev, staging, and production:
//
//   RENTALCRM_BASE_URL    (default: http://127.0.0.1:8787)
//   RENTALCRM_EMAIL       (default: cli-walk-<rand>@example.test)
//   RENTALCRM_PASSWORD    (default: a random string)
//   RENTALCRM_ACCOUNT     (default: "CLI Walk <date>")
//
// On a successful walk, exit 0. On any 4xx/5xx, exit 1 with the response
// body printed.
// ----------------------------------------------------------------------------

import { createRentalCrmClient } from '@rentalcrm/sdk';

const BASE = process.env.RENTALCRM_BASE_URL ?? 'http://127.0.0.1:8787';
const EMAIL = process.env.RENTALCRM_EMAIL ?? `cli-walk-${rnd()}@example.test`;
const PASSWORD = process.env.RENTALCRM_PASSWORD ?? `cli-walk-${rnd()}-pw`;
const ACCOUNT_NAME = process.env.RENTALCRM_ACCOUNT
  ?? `CLI Walk ${new Date().toISOString().slice(0, 16)}`;

function rnd(): string { return Math.random().toString(36).slice(2, 10); }
function idKey(): string {
  // The middleware accepts any non-empty Idempotency-Key. We mint a fresh
  // one per logical operation; real clients would persist a key across
  // retries of the SAME operation so a network blip doesn't double-write.
  return `cli-${Date.now()}-${rnd()}`;
}

let accessToken = '';
const client = createRentalCrmClient({
  baseUrl: BASE,
  accessToken: () => accessToken,
});

function log(step: number, label: string, extra?: string): void {
  const dot = label === 'OK' ? '✓' : label === 'FAIL' ? '✗' : '·';
  console.info(`${dot} step ${String(step).padStart(2, '0')}  ${label}${extra ? `  ${extra}` : ''}`);
}

interface ApiErrorShape { error?: { code?: string; message?: string; details?: unknown } }
function dieOnError(step: number, label: string, error: ApiErrorShape | unknown): never {
  log(step, 'FAIL', label);
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
}

async function main(): Promise<void> {
  console.info(`rentalcrm CLI walk → ${BASE}\n  email: ${EMAIL}\n`);

  // -------------------------------------------------------------------------
  // 1. signup -- creates user + account atomically
  // -------------------------------------------------------------------------
  const signup = await client.POST('/v1/auth/signup', {
    body: { email: EMAIL, password: PASSWORD, account_name: ACCOUNT_NAME },
  });
  if (signup.error) dieOnError(1, 'signup', signup.error);
  if (!signup.data) dieOnError(1, 'signup returned no body', signup);
  // Two-shape response: the 200 path returns user/account/session; the
  // 202 path is "pending email verification". This CLI only handles the
  // immediate-session case (Supabase Auth without confirmation).
  if ('pending_verification' in signup.data) {
    dieOnError(1, 'signup is pending email verification; configure Supabase to disable that for the CLI walk', signup.data);
  }
  accessToken = signup.data.session.access_token;
  const accountId = signup.data.account.id;
  const userId = signup.data.user.id;
  log(1, 'signup', `user=${userId.slice(0, 8)}… account=${accountId.slice(0, 8)}…`);

  // From here on every mutating call goes through /v1/accounts/:accountId/...
  // and requires an Idempotency-Key header. openapi-fetch lets us inject
  // per-call headers.
  const mutating = (h: Record<string, string> = {}) => ({ 'Idempotency-Key': idKey(), ...h });

  // -------------------------------------------------------------------------
  // 2. property + area (a unit)
  // -------------------------------------------------------------------------
  const propRes = await client.POST('/v1/accounts/{accountId}/properties', {
    params: { path: { accountId } },
    headers: mutating(),
    body: { name: '123 Main St', address: { line1: '123 Main', city: 'Boston', state: 'MA', zip: '02118' } },
  });
  if (propRes.error || !propRes.data) dieOnError(2, 'create property', propRes.error);
  const propertyId = propRes.data.id;
  log(2, 'property', propertyId.slice(0, 8) + '…');

  const areaRes = await client.POST('/v1/accounts/{accountId}/areas', {
    params: { path: { accountId } },
    headers: mutating(),
    body: { property_id: propertyId, kind: 'unit', name: 'Apt 2R' },
  });
  if (areaRes.error || !areaRes.data) dieOnError(3, 'create area', areaRes.error);
  const areaId = areaRes.data.id;
  log(3, 'area (unit)', areaId.slice(0, 8) + '…');

  // -------------------------------------------------------------------------
  // 4. tenancy
  // -------------------------------------------------------------------------
  const tenRes = await client.POST('/v1/accounts/{accountId}/tenancies', {
    params: { path: { accountId } },
    headers: mutating(),
    body: { area_id: areaId, start_date: '2026-01-01', status: 'active' },
  });
  if (tenRes.error || !tenRes.data) dieOnError(4, 'create tenancy', tenRes.error);
  const tenancyId = tenRes.data.id;
  log(4, 'tenancy', tenancyId.slice(0, 8) + '…');

  // -------------------------------------------------------------------------
  // 5. rent schedule + the next charge
  // -------------------------------------------------------------------------
  const schedRes = await client.POST('/v1/accounts/{accountId}/rent-schedules', {
    params: { path: { accountId } },
    headers: mutating(),
    body: {
      tenancy_id: tenancyId, kind: 'rent', amount_cents: 200000, currency: 'USD',
      due_day: 1, start_date: '2026-01-01',
    },
  });
  if (schedRes.error || !schedRes.data) dieOnError(5, 'create rent_schedule', schedRes.error);
  log(5, 'rent_schedule', `$2000/mo due day 1`);

  const chargeRes = await client.POST('/v1/accounts/{accountId}/charges', {
    params: { path: { accountId } },
    headers: mutating(),
    body: {
      tenancy_id: tenancyId, type: 'rent', amount_cents: 200000, currency: 'USD',
      due_date: '2026-02-01', period_start: '2026-02-01', period_end: '2026-02-28',
      description: 'February rent',
    },
  });
  if (chargeRes.error || !chargeRes.data) dieOnError(6, 'create charge', chargeRes.error);
  const chargeId = chargeRes.data.id;
  log(6, 'charge', `$2000 for February`);

  // -------------------------------------------------------------------------
  // 7. partial payment ($1500) -- leaves a $500 balance on the rent charge
  // -------------------------------------------------------------------------
  const payRes = await client.POST('/v1/accounts/{accountId}/payments', {
    params: { path: { accountId } },
    headers: mutating(),
    body: {
      tenancy_id: tenancyId, amount_cents: 150000, currency: 'USD',
      received_at: '2026-02-04T10:00:00Z', method: 'check', reference: '4567',
      allocations: [{ charge_id: chargeId, amount_cents: 150000 }],
    },
  });
  if (payRes.error || !payRes.data) dieOnError(7, 'create payment', payRes.error);
  log(7, 'payment', `$1500 partial → $500 balance remains`);

  // Read the ledger back to confirm.
  const ledger = await client.GET('/v1/accounts/{accountId}/tenancies/{tenancyId}/ledger', {
    params: { path: { accountId, tenancyId } },
  });
  if (ledger.error || !ledger.data) dieOnError(8, 'read ledger', ledger.error);
  log(8, 'ledger', `rent_balance=$${(ledger.data.totals.rent_balance_cents / 100).toFixed(2)}`);

  // -------------------------------------------------------------------------
  // 9. maintenance request + interaction
  // -------------------------------------------------------------------------
  const mreqRes = await client.POST('/v1/accounts/{accountId}/maintenance-requests', {
    params: { path: { accountId } },
    headers: mutating(),
    body: {
      area_id: areaId, title: 'Leaky kitchen faucet', description: 'Drip from cold side',
      severity: 'routine',
    },
  });
  if (mreqRes.error || !mreqRes.data) dieOnError(9, 'create maintenance_request', mreqRes.error);
  const mreqId = mreqRes.data.id;
  log(9, 'maintenance_request', mreqId.slice(0, 8) + '…');

  // The API derives interactions.actor from auth.uid() server-side, so
  // the request body doesn't include it (Phase 4 actor-integrity).
  const intRes = await client.POST('/v1/accounts/{accountId}/interactions', {
    params: { path: { accountId } },
    headers: mutating(),
    body: {
      party_type: 'tenant', channel: 'phone', direction: 'outbound',
      body: 'Spoke with tenant, scheduled plumber for Thursday',
      occurred_at: '2026-02-05T15:30:00Z',
      tenancy_id: tenancyId, maintenance_request_id: mreqId, area_id: areaId,
    },
  });
  if (intRes.error || !intRes.data) dieOnError(10, 'create interaction', intRes.error);
  log(10, 'interaction', intRes.data.id.slice(0, 8) + '…');

  // -------------------------------------------------------------------------
  // 11. inspection + item + complete
  // -------------------------------------------------------------------------
  const inspRes = await client.POST('/v1/accounts/{accountId}/inspections', {
    params: { path: { accountId } },
    headers: mutating(),
    body: { area_id: areaId, performed_at: '2026-02-15T14:00:00Z', notes: 'Move-in inspection' },
  });
  if (inspRes.error || !inspRes.data) dieOnError(11, 'create inspection', inspRes.error);
  const inspectionId = inspRes.data.id;
  log(11, 'inspection', inspectionId.slice(0, 8) + '…');

  const itemRes = await client.POST('/v1/accounts/{accountId}/inspections/{inspectionId}/items', {
    params: { path: { accountId, inspectionId } },
    headers: mutating(),
    body: { label: 'Kitchen sink faucet', condition: 'leaks (cold side)' },
  });
  if (itemRes.error || !itemRes.data) dieOnError(12, 'create inspection_item', itemRes.error);
  log(12, 'inspection_item', itemRes.data.id.slice(0, 8) + '…');

  const compRes = await client.POST('/v1/accounts/{accountId}/inspections/{id}/complete', {
    params: { path: { accountId, id: inspectionId } },
    headers: mutating(),
  });
  if (compRes.error || !compRes.data) dieOnError(13, 'complete inspection', compRes.error);
  log(13, 'inspection complete', `report=${compRes.data.report.attachment_id.slice(0, 8)}…`);

  // -------------------------------------------------------------------------
  // 14. evidence export (the killer artifact)
  // -------------------------------------------------------------------------
  const expRes = await client.POST('/v1/accounts/{accountId}/evidence-exports', {
    params: { path: { accountId } },
    headers: mutating(),
    body: { tenancy_id: tenancyId },
  });
  if (expRes.error || !expRes.data) dieOnError(14, 'create evidence_export', expRes.error);
  log(14, 'evidence_export',
    `${(expRes.data.size_bytes / 1024).toFixed(1)} KiB, sha256=${expRes.data.content_hash.slice(0, 12)}…, ` +
    `chain=${expRes.data.chain_verified ? 'verified' : 'BROKEN'}`,
  );

  // -------------------------------------------------------------------------
  console.info('\nOK: full flow exercised via the SDK alone.');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
