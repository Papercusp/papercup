/**
 * Coverage for spawn-signing — the HMAC-signed spawn-URL envelope. Security
 * critical, so this exercises the full sign→verify round-trip plus every
 * rejection path: tamper (mutated/removed signed param), expiry, missing/invalid
 * exp + sig, duplicate-param injection, and the allowlist (non-signed params
 * don't affect verification). The PG key store is mocked to a fixed key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const KEY_B64 = Buffer.from('ab'.repeat(32), 'hex').toString('base64'); // fixed 32-byte key
  const rows = [{ value_b64: KEY_B64, rotated_at: '2026-01-01T00:00:00.000Z' }];
  const db: Record<string, unknown> = {};
  Object.assign(db, {
    select: () => db,
    from: () => db,
    where: () => db,
    limit: async () => rows,
    insert: () => db,
    values: () => db,
    onConflictDoNothing: async () => undefined,
  });
  return { db };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ db: H.db }) };
});

import { signSpawnParams, verifySpawnParams, _resetSpawnSigningKeyCache } from './spawn-signing';

const FUTURE_MS = 4_000_000_000_000; // year ~2096, well past any real `now`
const urlFrom = (p: URLSearchParams) => `https://x/api/spawn?${p.toString()}`;

beforeEach(() => _resetSpawnSigningKeyCache());

describe('sign → verify round-trip', () => {
  it('a freshly signed URL verifies ok', async () => {
    const p = new URLSearchParams({ harness: 'h', workspace: 'w', role: 'worker', spawn: 's1' });
    await signSpawnParams(p, { nowMs: FUTURE_MS });
    expect(p.get('sig')).toBeTruthy();
    expect(await verifySpawnParams(urlFrom(p))).toEqual({ ok: true });
  });

  it('ignores non-allowlisted params (they are neither signed nor break verification)', async () => {
    const p = new URLSearchParams({ harness: 'h', role: 'worker' });
    await signSpawnParams(p, { nowMs: FUTURE_MS });
    p.set('extra', 'not-signed'); // appended after signing
    expect(await verifySpawnParams(urlFrom(p))).toEqual({ ok: true });
  });
});

describe('tamper rejection', () => {
  it('rejects a mutated signed param', async () => {
    const p = new URLSearchParams({ harness: 'h', role: 'worker' });
    await signSpawnParams(p, { nowMs: FUTURE_MS });
    p.set('role', 'operator'); // privilege bump after signing
    expect(await verifySpawnParams(urlFrom(p))).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a removed signed param', async () => {
    const p = new URLSearchParams({ harness: 'h', workspace: 'w', role: 'worker' });
    await signSpawnParams(p, { nowMs: FUTURE_MS });
    p.delete('workspace');
    expect((await verifySpawnParams(urlFrom(p))).ok).toBe(false);
  });
});

describe('exp handling', () => {
  it('rejects an expired URL', async () => {
    const p = new URLSearchParams({ harness: 'h', role: 'worker' });
    await signSpawnParams(p, { nowMs: 1000, ttlSec: 1 }); // exp = 2s, long in the past
    expect(await verifySpawnParams(urlFrom(p))).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a non-numeric exp', async () => {
    expect(await verifySpawnParams('https://x/?harness=h&exp=soon&sig=abc')).toEqual({
      ok: false,
      reason: 'invalid_exp',
    });
  });
});

describe('structural rejection', () => {
  it('missing sig', async () => {
    expect(await verifySpawnParams(`https://x/?harness=h&exp=${FUTURE_MS}`)).toEqual({
      ok: false,
      reason: 'missing_sig',
    });
  });
  it('missing exp', async () => {
    expect(await verifySpawnParams('https://x/?harness=h&sig=abc')).toEqual({
      ok: false,
      reason: 'missing_exp',
    });
  });
  it('rejects duplicate signed params (late-append injection)', async () => {
    const exp = Math.floor(FUTURE_MS / 1000);
    const res = await verifySpawnParams(`https://x/?harness=h&role=a&role=b&exp=${exp}&sig=abc`);
    expect(res).toEqual({ ok: false, reason: 'duplicate_param:role' });
  });
});
