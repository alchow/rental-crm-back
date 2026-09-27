import { describe, expect, it } from 'vitest';
import { createApiClient } from './helpers/integration';

const ACCOUNT_PATH = '/v1/accounts/account-id/properties';

function echoClient() {
  return createApiClient({
    async fetch(request) {
      return Response.json({
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
    },
  });
}

describe('integration API client', () => {
  it('forwards the caller token, JSON body, and explicit replay key', async () => {
    const response = await echoClient()('POST', ACCOUNT_PATH, {
      token: 'caller-jwt',
      body: { name: 'House' },
      idempotencyKey: 'same-intent',
      headers: { 'x-test': 'custom' },
    });
    expect(response.body).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer caller-jwt',
        'content-type': 'application/json',
        'idempotency-key': 'same-intent',
        'x-test': 'custom',
      },
      body: '{"name":"House"}',
    });
  });

  it('gives independent account mutations distinct keys', async () => {
    const api = echoClient();
    const first = await api('POST', ACCOUNT_PATH);
    const second = await api('DELETE', ACCOUNT_PATH);
    const headers = (body: unknown) => (body as { headers: Record<string, string> }).headers;
    expect(headers(first.body)['idempotency-key']).toMatch(/^t-.+/);
    expect(headers(second.body)['idempotency-key']).toMatch(/^t-.+/);
    expect(headers(first.body)['idempotency-key']).not.toBe(
      headers(second.body)['idempotency-key'],
    );
  });

  it.each([
    ['GET', ACCOUNT_PATH, undefined],
    ['POST', '/v1/auth/signup', undefined],
    ['POST', ACCOUNT_PATH, null],
  ] as const)('omits the key for %s %s with override %s', async (method, path, idempotencyKey) => {
    const response = await echoClient()(method, path, { idempotencyKey });
    expect((response.body as { headers: object }).headers).not.toHaveProperty('idempotency-key');
  });

  it('preserves multipart boundaries and file bytes', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0, 128, 255])], 'proof.bin'));
    const api = createApiClient({
      async fetch(request) {
        const received = await request.formData();
        const file = received.get('file') as File;
        expect(file.name).toBe('proof.bin');
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
        return new Response(null, { status: 204, headers: { 'x-test': 'response' } });
      },
    });
    expect(await api('POST', ACCOUNT_PATH, { multipart: form })).toMatchObject({
      status: 204,
      body: null,
      headers: { 'x-test': 'response' },
    });
  });

  it('fails on malformed JSON rather than allowing status-only assertions to pass', async () => {
    const api = createApiClient({ fetch: () => new Response('{broken', { status: 200 }) });
    await expect(api('GET', ACCOUNT_PATH)).rejects.toThrow(SyntaxError);
  });

  it('returns binary responses without UTF-8 decoding', async () => {
    const bytes = new Uint8Array([0, 128, 255]);
    const api = createApiClient({ fetch: () => new Response(bytes) });
    const response = await api('GET', '/download', { responseType: 'bytes' });
    expect(response.body).toEqual(bytes);
  });
});
