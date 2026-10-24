import { coerceDate } from './coercions';
import { z } from 'zod';

export type ImportedDate =
  | { kind: 'explicit'; value: string; raw: string }
  | { kind: 'defaulted'; value: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; raw: string };

/** Keep "missing" separate from "invalid" so a bad spreadsheet value can
 * never silently turn into a possession-date default. */
export function mapImportedDate(raw: string | null, defaultValue?: string): ImportedDate {
  if (raw !== null) {
    const value = coerceDate(raw);
    return value ? { kind: 'explicit', value, raw } : { kind: 'invalid', raw };
  }
  if (defaultValue !== undefined) return { kind: 'defaulted', value: defaultValue };
  return { kind: 'missing' };
}

export type ImportedTenancyMetadata =
  | {
      kind: 'valid';
      explicitTenancyId: string | null;
      startDateBasis: 'legacy_unverified' | 'possession_entitlement';
      actualMoveInDate: string | null;
    }
  | {
      kind: 'invalid';
      field: string;
      code: 'invalid_value' | 'unparseable_value';
      message: string;
    };

export function mapImportedTenancyMetadata(input: {
  explicitIdRaw: string | null;
  basisRaw: string | null;
  actualMoveInRaw: string | null;
  today: string;
}): ImportedTenancyMetadata {
  const explicit = input.explicitIdRaw ? z.string().uuid().safeParse(input.explicitIdRaw) : null;
  if (explicit && !explicit.success) {
    return {
      kind: 'invalid',
      field: 'existing_tenancy_id',
      code: 'invalid_value',
      message: 'existing tenancy ID must be a UUID',
    };
  }
  const basis = input.basisRaw ?? 'legacy_unverified';
  if (basis !== 'legacy_unverified' && basis !== 'possession_entitlement') {
    return {
      kind: 'invalid',
      field: 'start_date_basis',
      code: 'invalid_value',
      message: 'possession date meaning must be legacy_unverified or possession_entitlement',
    };
  }
  const moveIn = mapImportedDate(input.actualMoveInRaw);
  if (moveIn.kind === 'invalid') {
    return {
      kind: 'invalid',
      field: 'actual_move_in_date',
      code: 'unparseable_value',
      message: `unparseable actual move-in date "${moveIn.raw}"`,
    };
  }
  const actualMoveInDate = moveIn.kind === 'explicit' ? moveIn.value : null;
  if (actualMoveInDate && actualMoveInDate > input.today) {
    return {
      kind: 'invalid',
      field: 'actual_move_in_date',
      code: 'invalid_value',
      message: 'actual move-in date cannot be in the future',
    };
  }
  return {
    kind: 'valid',
    explicitTenancyId: explicit?.data ?? null,
    startDateBasis: basis,
    actualMoveInDate,
  };
}
