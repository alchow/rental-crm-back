import { describe, expect, it } from 'vitest';
import { mapDateRpcError } from '../src/routes/tenancies/rpc';
import { ApiError } from '../src/routes/_lib/error';

describe('setup conflict classification', () => {
  it.each([
    ['conflict: setup draft changed', 'setup_draft_changed'],
    [
      'conflict: existing rent history requires an explicit transition or ordinary correction',
      'billing_transition_required',
    ],
    ['conflict: a planned successor already occupies this billing boundary', 'conflict'],
  ])('classifies %s as %s', (message, code) => {
    try {
      mapDateRpcError({ code: 'P0001', message });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 409, code });
      return;
    }
    throw new Error('Expected the RPC error to be mapped');
  });
});
