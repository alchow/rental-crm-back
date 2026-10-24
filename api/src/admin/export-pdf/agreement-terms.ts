type Fact = Record<string, unknown>;
function object(value: unknown): Fact {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fact)
    : {};
}
export function dueRuleText(value: unknown): string {
  const rule = object(value);
  if (rule.kind === 'day_of_month') return `day ${String(rule.day)} of each month`;
  if (rule.kind === 'last_day') return 'last day of each month';
  if (rule.kind === 'other') return String(rule.text);
  return 'unknown';
}
export function feePolicyText(value: unknown): string {
  const fee = object(value);
  if (fee.kind === 'none') return 'no fee';
  if (fee.kind === 'fixed')
    return `${(Number(fee.amount_cents) / 100).toFixed(2)} ${String(fee.currency)}`;
  if (fee.kind === 'other') return String(fee.text);
  return 'unknown';
}
export function agreementTermsLines(lease: Fact): string[] {
  return [
    `Agreed rent due rule: ${dueRuleText(lease.rent_due_rule)}`,
    `Agreed grace days: ${lease.grace_days ?? 'unknown'}; late fee: ${feePolicyText(lease.late_fee_policy)}`,
    `Deposit agreement: ${
      lease.deposit_knowledge === 'none'
        ? 'no deposit'
        : lease.deposit_knowledge === 'amount'
          ? `${(Number(lease.deposit_amount_cents) / 100).toFixed(2)} ${String(lease.deposit_currency ?? lease.rent_currency)}`
          : 'unknown'
    }`,
    `Agreement type: ${lease.agreement_kind ?? 'original'}${lease.predecessor_lease_id ? `; predecessor ${String(lease.predecessor_lease_id)}` : ''}`,
    `Terms source: ${lease.terms_source ? JSON.stringify(lease.terms_source) : 'not recorded'}; recorded ${lease.terms_recorded_at ?? 'unknown'} by ${lease.terms_recorded_by ?? 'unknown'}`,
  ];
}
