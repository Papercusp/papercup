import { describe, it, expect, vi } from 'vitest';
import { verifyChannel1 } from './two-channel-verifier';

// ─── test helpers ─────────────────────────────────────────────────────────────

function makeFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const resp = responses[call++];
    if (!resp) throw new Error('unexpected fetch call ' + call);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function networkErrorFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

// ─── Channel 1 ────────────────────────────────────────────────────────────────

describe('verifyChannel1', () => {
  it('passes when /user id matches claimed id', async () => {
    const result = await verifyChannel1({
      token: 'tok-valid',
      claimedGithubUserId: 42,
      fetchFn: makeFetch([{ status: 200, body: { id: 42, login: 'alice' } }]),
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('fails with oauth_user_id_mismatch when id differs', async () => {
    const result = await verifyChannel1({
      token: 'tok-valid',
      claimedGithubUserId: 42,
      fetchFn: makeFetch([{ status: 200, body: { id: 99, login: 'bob' } }]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'oauth_user_id_mismatch' });
  });

  it('fails with oauth_token_revoked on 401', async () => {
    const result = await verifyChannel1({
      token: 'tok-expired',
      claimedGithubUserId: 1,
      fetchFn: makeFetch([{ status: 401, body: { message: 'Bad credentials' } }]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'oauth_token_revoked' });
  });

  it('fails with github_api_down on non-200/non-401 error', async () => {
    const result = await verifyChannel1({
      token: 'tok',
      claimedGithubUserId: 1,
      fetchFn: makeFetch([{ status: 503, body: {} }]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'github_api_down' });
  });

  it('fails with github_api_down on network error', async () => {
    const result = await verifyChannel1({
      token: 'tok',
      claimedGithubUserId: 1,
      fetchFn: networkErrorFetch(),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'github_api_down' });
  });
});
