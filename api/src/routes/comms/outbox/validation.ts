import type { z } from '@hono/zod-openapi';
import type { CreateOutboxBody } from '../schemas';
import type { getSb } from '../../../supabase/request-client';
import { asJson, nullableRpcArg } from '../../../supabase/db-types';
import { ApiError } from '../../_lib/error';
import { commDbError } from '../shared';

export function validateOutboxInput(body: z.infer<typeof CreateOutboxBody>): void {
  // SECURITY: JWT callers cannot claim core-authored system provenance.
  if (body.approval_ref.startsWith('system:')) {
    throw new ApiError(403, 'forbidden', 'system provenance is reserved for core-originated sends');
  }

  if (body.subject !== undefined && body.channel !== 'email') {
    throw new ApiError(400, 'invalid_request', 'subject is only valid on email sends', {
      fieldErrors: { subject: ['only valid when channel=email'] },
    });
  }

  // Thread sends derive Cc from participants; explicit Cc is for bare email only.
  if (body.cc_addresses !== undefined) {
    if (body.channel !== 'email') {
      throw new ApiError(400, 'invalid_request', 'cc_addresses is only valid on email sends', {
        fieldErrors: { cc_addresses: ['only valid when channel=email'] },
      });
    }
    if (body.thread_id !== undefined) {
      throw new ApiError(
        400,
        'invalid_request',
        'cc_addresses is only valid on bare sends; a thread leg derives its Cc from is_cc participants',
        { fieldErrors: { cc_addresses: ['not accepted with thread_id'] } },
      );
    }
  }

  // Bare-email party hints are verified against normalized addresses before insertion.
  if (body.to_party !== undefined || body.cc_parties !== undefined) {
    if (body.channel !== 'email') {
      throw new ApiError(
        400,
        'invalid_request',
        'party intent (to_party/cc_parties) is only valid on email sends',
        { fieldErrors: { to_party: ['only valid when channel=email'] } },
      );
    }
    if (body.thread_id !== undefined) {
      throw new ApiError(
        400,
        'invalid_request',
        'party intent (to_party/cc_parties) is only valid on bare sends; a thread leg derives parties from its participants',
        { fieldErrors: { to_party: ['not accepted with thread_id'] } },
      );
    }
  }
  if (body.to_party !== undefined && body.to_address === undefined) {
    throw new ApiError(400, 'invalid_request', 'to_party requires to_address', {
      fieldErrors: { to_party: ['requires to_address'] },
    });
  }
  if (body.cc_parties !== undefined && body.cc_addresses === undefined) {
    throw new ApiError(400, 'invalid_request', 'cc_parties requires cc_addresses', {
      fieldErrors: { cc_parties: ['requires cc_addresses'] },
    });
  }
}

type CcParty = { address: string; party_type: string; party_id: string };

export async function verifyOutboxParties(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  body: z.infer<typeof CreateOutboxBody>,
  toAddress: string | null,
  ccAddresses: string[] | null,
): Promise<CcParty[] | null> {
  // Return field-specific errors before the database independently verifies the snapshot.
  let ccPartiesPayload: CcParty[] | null = null;
  if (body.to_party !== undefined || body.cc_parties !== undefined) {
    // Each Cc hint must annotate an address the caller requested.
    const ccSet = new Set(ccAddresses ?? []);
    if (body.cc_parties !== undefined) {
      ccPartiesPayload = body.cc_parties.map((p) => ({
        address: p.address.toLowerCase(),
        party_type: p.party_type,
        party_id: p.party_id,
      }));
      for (const [i, p] of ccPartiesPayload.entries()) {
        if (!ccSet.has(p.address)) {
          throw new ApiError(
            400,
            'invalid_request',
            `cc_parties[${i}].address must match a cc_addresses entry`,
            { fieldErrors: { cc_parties: [`entry ${i} address is not in cc_addresses`] } },
          );
        }
      }
    }

    // Two parties cannot claim the same address.
    const claimed = new Map<string, string>();
    const allHints: { address: string; key: string }[] = [];
    if (body.to_party !== undefined && toAddress !== null) {
      allHints.push({
        address: toAddress,
        key: `${body.to_party.party_type}:${body.to_party.party_id}`,
      });
    }
    for (const p of ccPartiesPayload ?? []) {
      allHints.push({ address: p.address, key: `${p.party_type}:${p.party_id}` });
    }
    for (const h of allHints) {
      const prev = claimed.get(h.address);
      if (prev !== undefined && prev !== h.key) {
        throw new ApiError(
          409,
          'conflict',
          `address ${h.address} is claimed by two different parties`,
        );
      }
      claimed.set(h.address, h.key);
    }

    // Use the same scope/address predicate as the database snapshot trigger.
    const { data: verdicts, error: vErr } = await sb.rpc('check_outbox_party_intent', {
      p_account_id: accountId,
      p_tenancy_id: nullableRpcArg(body.tenancy_id ?? null),
      p_to_party_type: nullableRpcArg(body.to_party?.party_type ?? null),
      p_to_party_id: nullableRpcArg(body.to_party?.party_id ?? null),
      p_to_address: nullableRpcArg(body.to_party !== undefined ? toAddress : null),
      p_cc_parties: ccPartiesPayload !== null ? asJson(ccPartiesPayload) : null,
    });
    if (vErr) throw commDbError(vErr);
    for (const row of (verdicts ?? []) as {
      slot: string;
      hint_address: string;
      verdict: string;
    }[]) {
      if (row.verdict === 'ok') continue;
      const field = row.slot === 'to' ? 'to_party' : 'cc_parties';
      const msg =
        row.verdict === 'wrong_account'
          ? 'the referenced party does not belong to this account'
          : row.verdict === 'not_in_tenancy'
            ? 'the referenced tenant is not a member of the supplied tenancy'
            : 'the address does not resolve to the referenced party';
      throw new ApiError(422, 'invalid_request', msg, {
        fieldErrors: { [field]: [`${row.hint_address}: ${row.verdict}`] },
      });
    }
  }
  return ccPartiesPayload;
}
