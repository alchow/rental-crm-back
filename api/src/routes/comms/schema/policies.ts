import { z } from '@hono/zod-openapi';
import { CommChannel, CommPolicyKind, CommPolicyStatus, CommQuietHours } from './outbox';

// ---------------------------------------------------------------------------
// Policies — standing grants; creating one IS the approval act.
// ---------------------------------------------------------------------------

export const CommPolicy = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    policy_kind: CommPolicyKind,
    channel: CommChannel,
    template_id: z.string().nullable(),
    params: z.record(z.unknown()),
    // union-with-null (not .nullable()): the generator drops nullability
    // from a wrapped registered schema; the union form emits anyOf correctly.
    quiet_hours: z.union([CommQuietHours, z.null()]),
    status: CommPolicyStatus,
    approved_by: z.string().uuid(),
    approved_at: z.string(),
    revoked_by: z.string().uuid().nullable(),
    revoked_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('CommPolicy');

export const CreatePolicyBody = z
  .object({
    policy_kind: CommPolicyKind,
    channel: CommChannel,
    template_id: z.string().min(1).max(200).optional(),
    params: z.record(z.unknown()).default({}),
    quiet_hours: CommQuietHours.optional(),
  })
  .openapi('CreateCommPolicyBody');

export const PolicyListResponse = z
  .object({ data: z.array(CommPolicy), next_cursor: z.string().nullable() })
  .openapi('CommPolicyListResponse');
