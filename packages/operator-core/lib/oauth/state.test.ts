import { afterEach, describe, expect, it, vi } from 'vitest';

// The nonce store is PG-backed via getOrgPg().sql, and getOrgPg()'s Drizzle
// construct crashes under vitest ("null constructor"). Stub it with an in-memory
// nonce store that honours the three query shapes the SUT issues (INSERT,
// the claim CTE, and the reset DELETE) so the consume/replay logic is exercised
// deterministically without a live PG.
//
// ⚠ MUST mock the '@papercusp/db-org/connection' SUBPATH, not the package root.
// vi.mock is keyed by module specifier, and db-org's exports map resolves
// '.' -> src/index.ts but './connection' -> src/connection.ts — two distinct
// module records. state.ts imports getOrgPg from the subpath, so mocking the
// root leaves it bound to the REAL getOrgPg, which opens the live "org-admin"
// pool and trips the unit-lane detector (EI-19311807188719573) on every test
// here — including the pure signature/malformed cases, via afterEach's
// __resetForTest(). Keep this specifier in sync with state.ts's import.
const __nonces = new Map<string, { consumed: boolean; privateContext: Record<string, string> }>();
vi.mock('@papercusp/db-org/connection', async (orig) => {
  const sql: any = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join(' ');
      if (q.includes('INSERT INTO harness_shared.oauth_nonces')) {
        const n = values[0] as string;
        const privateContext = JSON.parse(values[3] as string) as Record<string, string>;
        if (!__nonces.has(n)) __nonces.set(n, { consumed: false, privateContext });
        return Promise.resolve([]);
      }
      if (q.includes('count(*)')) return Promise.resolve([{ n: __nonces.size }]);
      if (q.includes('WITH lookup')) {
        const n = values[0] as string;
        if (!__nonces.has(n)) return Promise.resolve([{ status: 'unknown' }]);
        const row = __nonces.get(n)!;
        if (row.consumed) return Promise.resolve([{ status: 'already' }]);
        row.consumed = true;
        return Promise.resolve([{ status: 'claimed', privateContext: row.privateContext }]);
      }
      if (q.includes('DELETE FROM harness_shared.oauth_nonces')) {
        if (!q.includes('exp_ms <')) __nonces.clear(); // reset (not the GC sweep)
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    { begin: vi.fn() },
  );
  return { ...((await orig()) as object), getOrgPg: () => ({ sql, db: {} }) };
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the per-install key file at a throwaway path BEFORE the first sign, so
// the suite never creates or adopts the real ~/.papercusp/oauth-state-key.
// The module reads this lazily inside getSecret(), so top-level is early enough.
process.env.PAPERCUSP_OAUTH_STATE_KEY_FILE = join(
  mkdtempSync(join(tmpdir(), 'papercusp-oauth-state-')),
  'oauth-state-key',
);
delete process.env.PAPERCUSP_OAUTH_STATE_SECRET;

import { __resetForTest, __resetSecretCacheForTest, signState, verifyAndConsumeState } from './state';

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
  // Regression, WI-10001496. getSecret() used to fall back to randomBytes(32)
  // cached module-scope, giving every PROCESS its own HMAC key. hono-host sets
  // reusePort:true and cluster-fork forks N request workers, so the kernel
  // routes authorize-start and the OAuth callback to DIFFERENT workers and the
  // callback verified under a key it did not have — every Google login failed
  // bad-signature, with nonce rows written by the start leg and never consumed.
  //
  // __resetForTest() drops the in-process key cache, which is exactly what a
  // sibling worker looks like: same key FILE, no shared memory. Under the old
  // per-process-random code this fails; it only passes if the key is durable.
  it('verifies a token signed before the in-process key cache was dropped (cross-worker)', async () => {
    const token = await signState(baseClaims);

    // Simulate the callback arriving at a DIFFERENT reusePort worker: same key
    // file and same nonce table, none of this process's memory.
    __resetSecretCacheForTest();

    const verified = await verifyAndConsumeState(token);
    expect(verified.error).toBeUndefined();
    expect(verified.ok).toBe(true);
    expect(verified.claims).toMatchObject(baseClaims);
  });

  it('refuses a configured secret shorter than the 32-character floor', async () => {
    process.env.PAPERCUSP_OAUTH_STATE_SECRET = 'too-short';
    __resetSecretCacheForTest();
    try {
      // Must THROW, not silently fall back to a random key — the old fallback
      // meant a misconfigured secret broke every login while looking configured.
      await expect(signState(baseClaims)).rejects.toThrow(/under the 32-character floor/);
    } finally {
      delete process.env.PAPERCUSP_OAUTH_STATE_SECRET;
      __resetSecretCacheForTest();
    }
  });

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

  it('returns server-side private context once without serializing it into state', async () => {
    const token = await signState(baseClaims, {
      privateContext: { codeVerifier: 'private-pkce-verifier' },
    });
    expect(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')).not.toContain('private-pkce-verifier');

    const result = await verifyAndConsumeState(token);
    expect(result.privateContext).toEqual({ codeVerifier: 'private-pkce-verifier' });
    expect((await verifyAndConsumeState(token)).error).toBe('already-consumed');
  });
});
