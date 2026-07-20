import { z } from '@hono/zod-openapi';

// Provider numbers assigned to an account. The agent orders these from the
// carrier and registers them here; landlords read them to know whether texting
// is switched on for their account.
//
// `capabilities` is what POST /comms/threads filters on (`capabilities @>
// [channel]`), so a number that cannot carry the channel is simply invisible to
// thread creation rather than a runtime send failure.
export const PlatformNumberCapability = z.enum(['sms', 'mms', 'voice']);

export const PlatformNumber = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    number: z.string(),
    provider: z.string(),
    capabilities: z.array(z.string()),
    status: z.enum(['active', 'released']),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('PlatformNumber');

export const PlatformNumberListResponse = z
  .object({ data: z.array(PlatformNumber) })
  .openapi('PlatformNumberListResponse');

// Registration is agent-only. `number` is validated to the same E.164 shape the
// table's CHECK enforces, so a malformed value fails as a 400 with a field
// error rather than a raw 23514 from the database.
export const RecordPlatformNumberBody = z
  .object({
    number: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'must be E.164, e.g. +14155550100')
      .openapi({ example: '+14155550100' }),
    provider: z.string().min(1).max(100).openapi({ example: 'telnyx' }),
    // Defaults to {sms} in the RPC when omitted or empty — an empty set would
    // make the number invisible to thread creation.
    capabilities: z.array(PlatformNumberCapability).min(1).optional(),
  })
  .openapi('RecordPlatformNumberBody');
