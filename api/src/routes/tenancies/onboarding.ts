import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { conflictResponse, errorResponses } from '../_lib/error';
import { CreateTenancyBody, MemberRole, TenancyStatus } from '../../schemas/importable';
import { CalendarDate } from '../../schemas/calendar-date';
import { AccountParam, AccountAndTenancyParam, Tenancy } from './schemas';
import { atomicDateArgs, dateRpc } from './rpc';

export const OnboardingProgress = z
  .object({
    tenancy_id: z.string().uuid(),
    selected_lease_id: z.string().uuid().nullable(),
    selected_lease_updated_at: z.string().nullable(),
    agreement_confirmed: z.boolean(),
    condition_decision: z.enum(['pending', 'in_progress', 'complete', 'deferred']),
    possession_confirmed_revision: z.number().int().nonnegative().nullable(),
    rent_decision: z.enum(['pending', 'configured', 'deferred']),
    deposit_decision: z.enum(['pending', 'configured', 'deferred']),
    revision: z.number().int().nonnegative(),
    date_revision: z.number().int().nonnegative(),
    effective_status: TenancyStatus,
    as_of_date: CalendarDate,
    clock_basis: z.literal('UTC'),
    updated_at: z.string().nullable(),
  })
  .openapi('TenancyOnboardingProgress');

const PatchProgress = z
  .object({
    expected_revision: z.number().int().nonnegative().optional(),
    selected_lease_id: z.string().uuid().nullable().optional(),
    agreement_confirmed: z.boolean().optional(),
    condition_decision: z.enum(['pending', 'in_progress', 'complete', 'deferred']).optional(),
    possession_confirmed_revision: z.number().int().nonnegative().nullable().optional(),
    rent_decision: z.enum(['pending', 'configured', 'deferred']).optional(),
    deposit_decision: z.enum(['pending', 'configured', 'deferred']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expected_revision'), {
    message: 'at least one progress decision is required',
  })
  .openapi('PatchTenancyOnboardingProgressBody');

const BootstrapBody = CreateTenancyBody.and(z.object({ tenant_id: z.string().uuid() })).openapi(
  'BootstrapTenancyBody',
);
const BootstrapResult = z
  .object({
    tenancy: Tenancy,
    member: z.object({
      id: z.string().uuid(),
      account_id: z.string().uuid(),
      tenancy_id: z.string().uuid(),
      tenant_id: z.string().uuid(),
      role: MemberRole,
      created_at: z.string(),
      updated_at: z.string(),
      deleted_at: z.string().nullable(),
    }),
  })
  .openapi('BootstrapTenancyResult');

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/onboarding-progress',
  tags: ['tenancies'],
  summary: 'Read onboarding decisions alongside authoritative completion facts',
  request: { params: AccountAndTenancyParam },
  responses: {
    200: {
      description: 'progress',
      content: { 'application/json': { schema: OnboardingProgress } },
    },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/onboarding-progress',
  tags: ['tenancies'],
  summary: 'Record onboarding confirmations or deferred work',
  request: {
    params: AccountAndTenancyParam,
    body: { required: true, content: { 'application/json': { schema: PatchProgress } } },
  },
  responses: {
    200: {
      description: 'progress',
      content: { 'application/json': { schema: OnboardingProgress } },
    },
    ...errorResponses,
    ...conflictResponse,
  },
});
const bootstrap = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/bootstrap',
  tags: ['tenancies'],
  summary: 'Create a tenancy and its primary member in one transaction',
  request: {
    params: AccountParam,
    body: { required: true, content: { 'application/json': { schema: BootstrapBody } } },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: BootstrapResult } } },
    ...errorResponses,
    ...conflictResponse,
  },
});

export const tenancyOnboardingApp = newApiApp();
tenancyOnboardingApp.openapi(get, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const result = await dateRpc<z.infer<typeof OnboardingProgress>>(
    c,
    'get_tenancy_onboarding_progress',
    {
      p_account_id: accountId,
      p_tenancy_id: tenancyId,
    },
  );
  return c.json(result, 200);
});
tenancyOnboardingApp.openapi(patch, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const result = await dateRpc<z.infer<typeof OnboardingProgress>>(
    c,
    'update_tenancy_onboarding_progress',
    {
      p_account_id: accountId,
      p_tenancy_id: tenancyId,
      p_payload: c.req.valid('json'),
    },
  );
  return c.json(result, 200);
});
tenancyOnboardingApp.openapi(bootstrap, async (c) => {
  const { accountId } = c.req.valid('param');
  const result = await dateRpc<z.infer<typeof BootstrapResult>>(c, 'bootstrap_tenancy', {
    p_account_id: accountId,
    ...atomicDateArgs(c, c.req.valid('json')),
  });
  c.set('idempotencyCompletedAtomically', true);
  return c.json(result, 201);
});
