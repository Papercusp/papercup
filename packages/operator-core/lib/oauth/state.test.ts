import { afterEach, describe, expect, it, vi } from 'vitest';

// The nonce store is PG-backed via getOrgPg().sql, and getOrgPg()'s Drizzle
// construct crashes under vitest ("null constructor"). Stub it with an in-memory
// nonce store that honours the three query shapes the SUT issues (INSERT,
// the claim CTE, and the reset DELETE) so the consume/replay logic is exercised
// deterministically without a live PG.
const __nonces = new Map<string, boolean>(); // nonce → consumed
vi.mock('@papercusp/db-org', async (orig) => {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('INSERT INTO harness_shared.oauth_nonces')) {
      const n = values[0] as string;
      if (!__nonces.has(n)) __nonces.set(n, false);
      return Promise.resolve([]);
    }
    if (q.includes('count(*)')) return Promise.resolve([{ n: __nonces.size }]);
    if (q.includes('WITH lookup')) {
      const n = values[0] as string;
      if (!__nonces.has(n)) return Promise.resolve([{ status: 'unknown' }]);
      if (__nonces.get(n)) return Promise.resolve([{ status: 'already' }]);
      __nonces.set(n, true);
      return Promise.resolve([{ status: 'claimed' }]);
    }
    if (q.includes('DELETE FROM harness_shared.oauth_nonces')) {
      if (!q.includes('exp_ms <')) __nonces.clear(); // reset (not the GC sweep)
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { ...((await orig()) as object), getOrgPg: () => ({ sql, db: {} }) };
});

import { __resetForTest, signState, verifyAndConsumeState } from './state';

const baseClaims = {
  plugin: 'github-repo',
  harness: 'demo',
  field: 'github_token',
  providerHost: 'github.com',
  provider: 'github',
};

afterEach(() => __resetForTest());

// signState / verifyAndConsumeState are async (nonce consume is durable now);
// every call must be awaited.
describe('OAuth state token', () => {
  it('round-trips a valid state token', async () => {
    const token = await signState(baseClaims);
    const result = await verifyAndConsumeState(token);
    expect(result.ok).toBe(true);
    expect(result.claims?.plugin).toBe('github-repo');
    expect(result.claims?.harness).toBe('demo');
  });

  it('rejects a tampered signature', async () => {
    const token = await signState(baseClaims);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    const result = await verifyAndConsumeState(tampered);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad-signature');
  });

  it('rejects malformed tokens', async () => {
    expect((await verifyAndConsumeState('')).ok).toBe(false);
    expect((await verifyAndConsumeState('garbage')).error).toBe('malformed');
    expect((await verifyAndConsumeState('a.b.c')).error).toBe('bad-signature');
  });

  it('rejects expired tokens', async () => {
    const token = await signState(baseClaims, -1000);
    const result = await verifyAndConsumeState(token);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('expired');
  });

  it('rejects already-consumed nonces (replay protection)', async () => {
    const token = await signState(baseClaims);
    const first = await verifyAndConsumeState(token);
    expect(first.ok).toBe(true);
    const second = await verifyAndConsumeState(token);
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already-consumed');
  });

  it('issues independent tokens for concurrent flows', async () => {
    const a = await signState({ ...baseClaims, plugin: 'plugin-a' });
    const b = await signState({ ...baseClaims, plugin: 'plugin-b' });
    expect(a).not.toBe(b);
    const ra = await verifyAndConsumeState(a);
    const rb = await verifyAndConsumeState(b);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(ra.claims?.plugin).toBe('plugin-a');
    expect(rb.claims?.plugin).toBe('plugin-b');
  });
});
