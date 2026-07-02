// Agent-firewall branch spec (comms build M0). assertAgentJournalWrite is a
// pure function; every principal x body branch is checked here without a DB.
// The integration tier (agent-principal.test.ts) re-covers the load-bearing
// paths end-to-end against real RLS.
//
// The communication rule under test (provenance convention, all repos):
//   approval_ref='proposal:<id>' + approved_by  -> human approved this message
//   approval_ref='grant:<id>'    (no approved_by) -> standing-policy send
//   anything else                                 -> 403 (no fabricated contacts)

import { describe, expect, it } from 'vitest';
import { assertAgentJournalWrite, type AgentFirewallBody } from '../src/routes/_lib/agent-firewall';
import { ApiError } from '../src/routes/_lib/error';
import type { Principal } from '../src/middleware/principal';

const AGENT: Principal = { type: 'agent', userId: '00000000-0000-4000-8000-00000000000a' };
const USER: Principal = { type: 'user', userId: '00000000-0000-4000-8000-00000000000b' };
const APPROVER = '00000000-0000-4000-8000-00000000000c';

function firewallError(principal: Principal, body: AgentFirewallBody): ApiError | null {
  try {
    assertAgentJournalWrite(principal, body);
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
}

describe('agent principal', () => {
  it('rejects corrections/retractions regardless of provenance', () => {
    const err = firewallError(AGENT, {
      corrects_id: 'x',
      approval_ref: 'proposal:1',
      approved_by: APPROVER,
    });
    expect(err?.status).toBe(403);
    expect(err?.code).toBe('agent_forbidden');
  });

  it('rejects a communication without approval_ref (explicit kind)', () => {
    const err = firewallError(AGENT, { kind: 'communication', body: 'hi' });
    expect(err?.status).toBe(403);
    expect(err?.code).toBe('agent_entry_type_forbidden');
  });

  it('rejects a communication without approval_ref (default kind)', () => {
    // kind omitted defaults to 'communication' -- the free-text fast path.
    const err = firewallError(AGENT, { body: 'hi' });
    expect(err?.status).toBe(403);
    expect(err?.code).toBe('agent_entry_type_forbidden');
  });

  it('rejects a communication whose approval_ref is neither approved nor grant-prefixed', () => {
    const err = firewallError(AGENT, { kind: 'communication', approval_ref: 'proposal:1' });
    expect(err?.status).toBe(403);
    expect(err?.code).toBe('agent_entry_type_forbidden');
  });

  it("rejects a communication with a ref merely CONTAINING 'grant:'", () => {
    const err = firewallError(AGENT, { kind: 'communication', approval_ref: 'x-grant:1' });
    expect(err?.status).toBe(403);
  });

  it('allows a proposal-approved communication (approval_ref + approved_by + external_ref)', () => {
    expect(
      firewallError(AGENT, {
        kind: 'communication',
        approval_ref: 'proposal:1',
        approved_by: APPROVER,
        external_ref: 'SM1',
      }),
    ).toBeNull();
  });

  it("allows a policy-authorized communication (grant: ref, no approved_by)", () => {
    expect(
      firewallError(AGENT, { kind: 'communication', approval_ref: 'grant:22', external_ref: 'SM2' }),
    ).toBeNull();
  });

  it('allows a grant-ref communication that ALSO carries approved_by', () => {
    expect(
      firewallError(AGENT, {
        kind: 'communication',
        approval_ref: 'grant:22',
        approved_by: APPROVER,
        external_ref: 'SM3',
      }),
    ).toBeNull();
  });

  it('requires external_ref on a provenance-complete communication (mirrors the DB trigger)', () => {
    const err = firewallError(AGENT, { kind: 'communication', approval_ref: 'grant:22' });
    expect(err?.status).toBe(400);
    expect(err?.code).toBe('invalid_request');
  });

  it('requires both approval fields on a note', () => {
    const missingBoth = firewallError(AGENT, { kind: 'note' });
    expect(missingBoth?.status).toBe(400);
    const missingRef = firewallError(AGENT, { kind: 'note', approved_by: APPROVER });
    expect(missingRef?.status).toBe(400);
    const missingBy = firewallError(AGENT, { kind: 'note', approval_ref: 'proposal:1' });
    expect(missingBy?.status).toBe(400);
    expect(
      firewallError(AGENT, { kind: 'note', approval_ref: 'proposal:1', approved_by: APPROVER }),
    ).toBeNull();
  });

  it('requires approval_ref on every agent_event', () => {
    const err = firewallError(AGENT, { kind: 'agent_event', entry_type: 'proposal_created' });
    expect(err?.status).toBe(400);
    expect(
      firewallError(AGENT, {
        kind: 'agent_event',
        entry_type: 'proposal_created',
        approval_ref: 'proposal:1',
      }),
    ).toBeNull();
  });

  it('requires an entity ref on step_executed', () => {
    const err = firewallError(AGENT, {
      kind: 'agent_event',
      entry_type: 'step_executed',
      approval_ref: 'proposal:1',
    });
    expect(err?.status).toBe(400);
    expect(
      firewallError(AGENT, {
        kind: 'agent_event',
        entry_type: 'step_executed',
        approval_ref: 'proposal:1',
        tenancy_id: 'x',
      }),
    ).toBeNull();
  });

  it('requires approved_by on proposal_approved', () => {
    const err = firewallError(AGENT, {
      kind: 'agent_event',
      entry_type: 'proposal_approved',
      approval_ref: 'proposal:1',
    });
    expect(err?.status).toBe(400);
  });

  it('bounds agent_event bodies at 1000 chars', () => {
    const err = firewallError(AGENT, {
      kind: 'agent_event',
      entry_type: 'proposal_created',
      approval_ref: 'proposal:1',
      body: 'x'.repeat(1001),
    });
    expect(err?.status).toBe(400);
  });
});

describe('landlord principal', () => {
  it('allows a plain communication and a plain note', () => {
    expect(firewallError(USER, { kind: 'communication' })).toBeNull();
    expect(firewallError(USER, {})).toBeNull();
    expect(firewallError(USER, { kind: 'note' })).toBeNull();
  });

  it('rejects agent_event kind and entry_type', () => {
    expect(firewallError(USER, { kind: 'agent_event' })?.code).toBe('agent_only');
    expect(firewallError(USER, { kind: 'note', entry_type: 'proposal_created' })?.code).toBe(
      'agent_only',
    );
  });

  it('rejects approval fields', () => {
    expect(firewallError(USER, { approved_by: APPROVER })?.status).toBe(400);
    expect(firewallError(USER, { approval_ref: 'grant:1' })?.status).toBe(400);
  });

  it('rejects external_ref (no hand-fabricated provider refs)', () => {
    const err = firewallError(USER, { kind: 'communication', external_ref: 'SM123' });
    expect(err?.status).toBe(400);
  });
});
