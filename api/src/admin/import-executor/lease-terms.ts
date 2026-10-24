import type { z } from 'zod';
import { LateFeePolicy, RentDueRule } from '../../schemas/lease-terms';
import { coerceCurrency, coerceMoney } from './coercions';

type ValueReader = (field: string) => string | null;
type Result =
  | {
      kind: 'valid';
      terms: {
        rent_due_rule: z.infer<typeof RentDueRule>;
        grace_days: number | null;
        late_fee_policy: z.infer<typeof LateFeePolicy>;
        deposit_knowledge: 'unknown' | 'none' | 'amount';
        deposit_amount_cents: number;
        deposit_currency?: string;
        terms_source: { kind: 'import' };
      };
    }
  | { kind: 'invalid'; field: string; message: string };

// INVARIANT: A written formula must never become a fixed amount through digit stripping.
export function exactImportedMoney(raw: string | null): number | null {
  if (
    raw === null ||
    !/^(?:[A-Za-z]{3}\s*|[$£€¥]\s*)?\d+(?:,\d{3})*(?:\.\d{1,2})?(?:\s*[A-Za-z]{3})?$/.test(
      raw.trim(),
    )
  )
    return null;
  const value = coerceMoney(raw);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

export function mapImportedLeaseTerms(getValue: ValueReader): Result {
  const invalid = (field: string, message: string): Result => ({ kind: 'invalid', field, message });
  const dueKind = getValue('rent_due_kind') ?? 'unknown';
  const dayRaw = getValue('rent_due_day');
  const dueText = getValue('rent_due_text');
  const day = dayRaw !== null && /^\d+$/.test(dayRaw) ? Number(dayRaw) : null;
  const due = RentDueRule.safeParse(
    dueKind === 'day_of_month'
      ? { kind: dueKind, day }
      : dueKind === 'other'
        ? { kind: dueKind, text: dueText }
        : { kind: dueKind },
  );
  if (
    !due.success ||
    (dayRaw !== null && dueKind !== 'day_of_month') ||
    (dueText !== null && dueKind !== 'other')
  )
    return invalid(
      'rent_due_kind',
      'lease due rule requires its explicit kind and matching day/text',
    );

  const graceRaw = getValue('grace_days');
  const grace = graceRaw === null ? null : /^\d+$/.test(graceRaw) ? Number(graceRaw) : NaN;
  if (grace !== null && (!Number.isSafeInteger(grace) || grace > 2147483647))
    return invalid('grace_days', 'grace days must be an explicit nonnegative integer');

  const feeKind = getValue('late_fee_kind') ?? 'unknown';
  const feeAmount = getValue('late_fee_amount');
  const feeCurrency = getValue('late_fee_currency');
  const feeText = getValue('late_fee_text');
  const fee = LateFeePolicy.safeParse(
    feeKind === 'fixed'
      ? {
          kind: feeKind,
          amount_cents: exactImportedMoney(feeAmount),
          currency: coerceCurrency(feeCurrency),
        }
      : feeKind === 'other'
        ? { kind: feeKind, text: feeText }
        : { kind: feeKind },
  );
  if (
    !fee.success ||
    ((feeAmount !== null || feeCurrency !== null) && feeKind !== 'fixed') ||
    (feeText !== null && feeKind !== 'other')
  )
    return invalid(
      'late_fee_kind',
      'late fee requires an explicit kind and matching amount/currency or written text',
    );

  const depositRaw = getValue('deposit_amount');
  const deposit =
    depositRaw === null
      ? getValue('deposit_knowledge') === 'none'
        ? 0
        : null
      : exactImportedMoney(depositRaw);
  if (depositRaw !== null && deposit === null)
    return invalid('deposit_amount', 'unparseable deposit amount');
  const knowledge =
    getValue('deposit_knowledge') ??
    (deposit === null ? 'unknown' : deposit === 0 ? 'none' : 'amount');
  if (
    !['unknown', 'none', 'amount'].includes(knowledge) ||
    (knowledge === 'none' && deposit !== 0) ||
    (knowledge === 'amount' && (deposit === null || deposit === 0)) ||
    (knowledge === 'unknown' && deposit !== null)
  )
    return invalid(
      'deposit_knowledge',
      'deposit knowledge must agree with the explicit amount; an omitted amount stays unknown',
    );
  const depositCurrencyRaw = getValue('deposit_currency');
  const depositCurrency =
    coerceCurrency(depositCurrencyRaw) ?? coerceCurrency(getValue('rent_currency'));
  if (
    (depositCurrencyRaw !== null && !coerceCurrency(depositCurrencyRaw)) ||
    (deposit !== null && deposit > 0 && !depositCurrency)
  )
    return invalid(
      'deposit_currency',
      'a stated deposit amount requires an explicit deposit or lease currency',
    );
  return {
    kind: 'valid',
    terms: {
      rent_due_rule: due.data,
      grace_days: grace,
      late_fee_policy: fee.data,
      deposit_knowledge: knowledge as 'unknown' | 'none' | 'amount',
      deposit_amount_cents: deposit ?? 0,
      ...(depositCurrency && deposit !== null ? { deposit_currency: depositCurrency } : {}),
      terms_source: { kind: 'import' },
    },
  };
}
