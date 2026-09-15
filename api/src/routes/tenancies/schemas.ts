import { z } from '@hono/zod-openapi';
import { CalendarDate } from '../../schemas/calendar-date';
import { TenancyStartDateBasis, TenancyStatus } from '../../schemas/importable';

export const Tenancy = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    area_id: z.string().uuid(),
    start_date: CalendarDate.openapi({
      description: 'Possession start. This is independent of lease terms and rent schedules.',
    }),
    start_date_basis: TenancyStartDateBasis,
    actual_move_in_date: CalendarDate.nullable(),
    date_revision: z.number().int().nonnegative(),
    end_date: CalendarDate.nullable(),
    status: TenancyStatus,
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Tenancy');

export const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

export const AccountAndIdParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

export const AccountAndTenancyParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z.string().uuid().openapi({ param: { name: 'tenancyId', in: 'path' } }),
});

export const DateFacts = z
  .object({
    start_date: CalendarDate,
    start_date_basis: TenancyStartDateBasis,
    actual_move_in_date: CalendarDate.nullable(),
    status: TenancyStatus,
    end_date: CalendarDate.nullable(),
    date_revision: z.number().int().nonnegative(),
  })
  .openapi('TenancyDateFacts');

export const DateChanges = z
  .object({
    start_date: CalendarDate.optional(),
    start_date_basis: TenancyStartDateBasis.optional(),
    actual_move_in_date: CalendarDate.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one change is required' })
  .openapi('TenancyDateChanges');

export const DateReasonCode = z.enum([
  'data_entry_error',
  'possession_delayed',
  'concession',
  'renewal',
  'early_access',
  'other',
]);

export const SelectedDateContext = {
  lease_id: z.string().uuid().optional(),
  rent_schedule_id: z.string().uuid().optional(),
};

export const ContextFingerprint = z.string().min(1).max(256);
