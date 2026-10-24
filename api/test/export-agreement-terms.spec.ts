import { describe, expect, it } from 'vitest';
import {
  agreementTermsLines,
  feePolicyText,
  dueRuleText,
} from '../src/admin/export-pdf/agreement-terms';
describe('exported agreement evidence', () => {
  it('does not turn legacy zero or missing policy into confirmed no deposit or no fee', () => {
    const lines = agreementTermsLines({ deposit_amount_cents: 0 });
    expect(lines).toContain('Deposit agreement: unknown');
    expect(lines).toContain('Agreed grace days: unknown; late fee: unknown');
  });
  it('retains unsupported written terms and explicit zero grace', () => {
    expect(dueRuleText({ kind: 'day_of_month', day: 31 })).toContain('31');
    expect(feePolicyText({ kind: 'other', text: '5% after ten days' })).toBe('5% after ten days');
    expect(
      agreementTermsLines({
        grace_days: 0,
        late_fee_policy: { kind: 'none' },
        deposit_knowledge: 'none',
      }),
    ).toContain('Agreed grace days: 0; late fee: no fee');
  });
  it('prints a fixed fee with its actual currency', () => {
    expect(feePolicyText({ kind: 'fixed', amount_cents: 5000, currency: 'EUR' })).toBe('50.00 EUR');
  });
});
