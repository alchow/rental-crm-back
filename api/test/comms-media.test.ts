import {
  configureIntegrationEnv,
  createApiClient,
  assertStatus,
  assert,
} from './helpers/integration';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

configureIntegrationEnv('8801');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { getAdminClient, _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const { loadExportData } = await import('../src/admin/export-pdf');
const { renderExportPdf } = await import('../src/admin/export-pdf/render');
const api = createApiClient(buildApp());
const admin = getAdminClient();

async function signup(label: string) {
  return assertStatus(
    await api('POST', '/v1/auth/signup', {
      body: {
        email: `mms-${label}-${crypto.randomUUID()}@example.test`,
        password: `long-password-${crypto.randomUUID()}`,
        account_name: 'MMS tests',
      },
    }),
    200,
    'signup',
  ) as { account: { id: string }; user: { id: string }; session: { access_token: string } };
}
const owner = await signup('owner');
const agent = await signup('agent');
const other = await signup('other');
const accountId = owner.account.id;
const token = owner.session.access_token;
const agentToken = agent.session.access_token;
const base = `/v1/accounts/${accountId}`;
const added = await admin
  .from('account_members')
  .insert({ account_id: accountId, user_id: agent.user.id, role: 'agent' });
if (added.error) throw new Error(added.error.message);
const tenant = assertStatus(
  await api('POST', `${base}/tenants`, { token, body: { full_name: 'Photo sender' } }),
  201,
  'tenant',
) as { id: string };
const platform = `+1909${String(Date.now()).slice(-7)}`;
const sender = `+1617${String(Date.now()).slice(-7)}`;
const provisioned = await admin.from('platform_numbers').insert({
  account_id: accountId,
  number: platform,
  provider: 'telnyx',
  capabilities: ['sms', 'mms'],
});
if (provisioned.error) throw new Error(provisioned.error.message);
const thread = assertStatus(
  await api('POST', `${base}/comms/threads`, {
    token,
    body: {
      kind: 'bridged_tenant',
      mode: 'bridged',
      channel: 'sms',
      participants: [{ party_type: 'tenant', party_id: tenant.id, address: sender }],
    },
  }),
  201,
  'thread',
) as { id: string };
interface Media {
  id: string;
  provider_media_index: number;
  state: string;
  failure_code: string | null;
  attachment: { id: string; content_hash: string } | null;
}
interface Capture {
  interaction_id: string;
  media: Media[];
}
async function capture(count = 2, extra: Record<string, unknown> = {}) {
  const body = {
    provider: 'telnyx',
    provider_msg_id: crypto.randomUUID(),
    to_number: platform,
    from_address: sender,
    channel: 'sms',
    received_at: new Date().toISOString(),
    media: Array.from({ length: count }, (_, provider_media_index) => ({
      provider_media_index,
      url: `https://media.telnyx.test/${provider_media_index}`,
      content_type: 'image/png',
    })),
    ...extra,
  };
  const result = assertStatus(
    await api('POST', `${base}/comms/inbound`, { token: agentToken, body }),
    200,
    'capture',
  ) as Capture;
  return { body, result, path: `${base}/interactions/${result.interaction_id}` };
}
const original = await capture();
assert(
  original.result.media.length === 2 && original.result.media.every((s) => s.state === 'pending'),
  'photo-only atomic manifest',
);
const row = await admin
  .from('interactions')
  .select('body,occurred_at')
  .eq('id', original.result.interaction_id)
  .single();
assert(row.data?.body === null, 'photo-only body preserved');
const snapshot = new Date().toISOString();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=',
  'base64',
);
const hash = createHash('sha256').update(png).digest('hex');
async function upload(path: string, slotId: string | undefined, bytes: Buffer = png) {
  return api('POST', `${path}/attachments`, {
    token: agentToken,
    body: {
      filename: 'sink.png',
      content_type: 'image/png',
      data_b64: bytes.toString('base64'),
      media_slot_id: slotId,
    },
  });
}
const stored = assertStatus(
  await upload(original.path, original.result.media[0]!.id),
  201,
  'upload',
) as { id: string };
assertStatus(
  await upload(original.path, original.result.media[1]!.id),
  201,
  'duplicate bytes second slot',
);
const media = assertStatus(await api('GET', `${original.path}/media`, { token }), 200, 'media') as {
  data: Media[];
};
assert(
  media.data.every(
    (s) =>
      s.state === 'saved' && s.attachment?.id === stored.id && s.attachment.content_hash === hash,
  ),
  'duplicate slots share one file',
);
const replay = assertStatus(
  await api('POST', `${base}/comms/inbound`, { token: agentToken, body: original.body }),
  200,
  'replay',
) as Capture;
assert(
  replay.interaction_id === original.result.interaction_id &&
    replay.media[0]?.id === media.data[0]?.id &&
    replay.media.every((s) => s.state === 'saved'),
  'capture replay retains slots',
);
for (const path of [
  `${base}/attachments/${stored.id}/download`,
  `${original.path}/attachments/${stored.id}/download`,
]) {
  const download = await api('GET', path, { token, responseType: 'bytes' });
  assert(
    download.status === 200 && Buffer.from(download.body as Uint8Array).equals(png),
    'both download paths preserve received bytes',
  );
}
const threadPage = assertStatus(
  await api('GET', `${base}/comms/threads/${thread.id}`, { token }),
  200,
  'thread page',
) as { messages: { id: string; media: Media[] }[] };
assert(
  threadPage.messages.find((m) => m.id === original.result.interaction_id)?.media[0]?.state ===
    'saved',
  'thread bulk metadata',
);
const history = assertStatus(
  await api(
    'GET',
    `${base}/comms/tenants/${tenant.id}/messages?snapshot=${encodeURIComponent(snapshot)}`,
    { token },
  ),
  200,
  'snapshot history',
) as { data: { id: string; media: Media[] }[] };
assert(
  history.data.find((m) => m.id === original.result.interaction_id)?.media[0]?.state === 'saved',
  'snapshot includes current media',
);
const events = await admin
  .from('events')
  .select('entity_type')
  .eq('account_id', accountId)
  .eq('entity_id', original.result.media[0]!.id);
assert(
  (events.data?.length ?? 0) >= 2 &&
    events.data?.every((e) => e.entity_type === 'comm_message_media'),
  'slot emits account events',
);
const changed = await admin
  .from('interactions')
  .select('occurred_at')
  .eq('id', original.result.interaction_id)
  .single();
assert(
  changed.data?.occurred_at === row.data?.occurred_at,
  'upload preserves original received time',
);

const excess = await capture(12);
assert(
  excess.result.media.length === 12 &&
    excess.result.media
      .slice(10)
      .every((s) => s.state === 'rejected' && s.failure_code === 'too_many_files'),
  'excess files explicit',
);
const partial = await capture(3, {
  body: 'The sink is leaking',
  media: [
    { provider_media_index: 0, url: 'https://media.telnyx.test/ok' },
    { provider_media_index: 1, rejection_code: 'invalid_descriptor' },
    { provider_media_index: 2, url: 'https://media.telnyx.test/large', size_bytes: 10485761 },
  ],
});
assert(
  partial.result.media[0]?.state === 'pending' &&
    partial.result.media[1]?.failure_code === 'invalid_descriptor' &&
    partial.result.media[2]?.failure_code === 'file_too_large',
  'malformed descriptor preserves valid message',
);
const slot = partial.result.media[0]!;
async function outcome(state: string, generation = 0) {
  return api('POST', `${partial.path}/media/${slot.id}/outcome`, {
    token: agentToken,
    body: { state, failure_code: 'download_failed', attempt_generation: generation },
  });
}
assertStatus(await outcome('failed'), 200, 'failure outcome');
assert(
  (assertStatus(await outcome('retrying'), 200, 'stale retry') as Media).state === 'failed',
  'failed cannot reopen same generation',
);
assert(
  (assertStatus(await outcome('retrying', 1), 200, 'repair retry') as Media).state === 'retrying',
  'explicit repair generation',
);
assertStatus(await upload(partial.path, slot.id), 201, 'repair save');
assert(
  (assertStatus(await outcome('failed', 2), 200, 'delayed failure') as Media).state === 'saved',
  'saved does not regress',
);
assertStatus(
  await upload(partial.path, partial.result.media[1]!.id),
  409,
  'rejected slot cannot save',
);
assertStatus(
  await upload(partial.path, original.result.media[0]!.id),
  404,
  'foreign message slot rejected',
);
assertStatus(
  await api('POST', `${partial.path}/media/${slot.id}/outcome`, {
    token,
    body: { state: 'failed', failure_code: 'download_failed' },
  }),
  403,
  'human cannot change ingestion',
);
const foreign = await api('GET', `${original.path}/media`, { token: other.session.access_token });
assert([403, 404].includes(foreign.status), 'cross-account read denied');
const forged = await fetch(
  `${process.env.SUPABASE_URL}/rest/v1/comm_message_media?id=eq.${slot.id}`,
  {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY!,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ state: 'failed', attachment_id: null, failure_code: 'download_failed' }),
  },
);
assert(forged.status >= 400, 'RLS/privileges reject direct outcome write');

const capped = await capture(10);
const responses = await Promise.all(
  Array.from({ length: 12 }, (_, i) => upload(capped.path, undefined, Buffer.from(`file-${i}`))),
);
assert(
  responses.filter((r) => r.status === 201).length === 10 &&
    responses.filter((r) => r.status === 400).length === 2,
  'concurrent uploads enforce cap',
);
const winner = responses.findIndex((r) => r.status === 201);
assertStatus(
  await upload(capped.path, undefined, Buffer.from(`file-${winner}`)),
  201,
  'duplicate succeeds at cap',
);
const count = await admin
  .from('attachments')
  .select('id', { count: 'exact', head: true })
  .eq('account_id', accountId)
  .eq('entity_id', capped.result.interaction_id)
  .is('deleted_at', null);
assert(count.count === 10, 'count never exceeds cap');

const scope = { accountId, tenantId: tenant.id, exporter: owner.user.id };
const data = await loadExportData(scope);
const pdf = await renderExportPdf({
  scope,
  data,
  generatedAt: new Date(),
  chain: { ok: true, message: 'test', broken_at: null, broken_event_no: null },
});
assert(Buffer.from(pdf).includes(Buffer.from('/Subtype /Image')), 'evidence PDF embeds saved PNG');
await writeFile('/tmp/rentalcrm-mms-evidence.pdf', pdf);

const tombstone = await admin
  .from('attachments')
  .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  .eq('id', stored.id);
if (tombstone.error) throw new Error(tombstone.error.message);
assertStatus(
  await upload(original.path, original.result.media[0]!.id),
  409,
  'removed attachment cannot resurrect',
);
assertStatus(
  await api('GET', `${base}/attachments/${stored.id}/download`, { token, responseType: 'bytes' }),
  404,
  'deleted file hidden',
);
const withdrawn = await capture(1);
const deleted = await admin
  .from('interactions')
  .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  .eq('id', withdrawn.result.interaction_id);
if (deleted.error) throw new Error(deleted.error.message);
assertStatus(
  await upload(withdrawn.path, withdrawn.result.media[0]!.id),
  409,
  'deleted parent blocks in-flight upload',
);
const rawRemoved = await admin
  .from('inbound_raw')
  .delete()
  .eq('provider_msg_id', original.body.provider_msg_id);
if (rawRemoved.error) throw new Error(rawRemoved.error.message);
const survivor = await admin
  .from('comm_message_media')
  .select('id')
  .eq('interaction_id', original.result.interaction_id);
assert(survivor.data?.length === 2, 'manifest survives restricted raw retention');
console.info(
  'OK: MMS atomic capture, replay, partial failure, concurrency, storage, PDF, events, authorization, and deletion.',
);
