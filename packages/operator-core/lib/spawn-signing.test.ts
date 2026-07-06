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
    onConflictDoUpdate: async () => undefined,
  });
  return { db };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ db: H.db }) };
});

import {
  signSpawnParams,
  verifySpawnParams,
  _resetSpawnSigningKeyCache,
  _resetVerifiedSpawns,
  recordVerifiedSpawn,
  classifyAndConsumeFailure,
  spawnSigFailureGuidance,
  rotateSpawnSigningKey,
} from './spawn-signing';

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

  // 2026-07-01: no time-based re-minting — the default is a PERMANENT (exp=0) URL.
  it('PERMANENT by default (exp=0): mints exp=0 and never expires', async () => {
    const p = new URLSearchParams({ harness: 'h', workspace: 'w', role: 'papercup', spawn: 's1' });
    const { exp } = await signSpawnParams(p); // no ttlSec ⇒ permanent
    expect(exp).toBe(0);
    expect(await verifySpawnParams(urlFrom(p))).toEqual({ ok: true });
  });

  it('a permanent (exp=0) URL STILL blocks role escalation (sig covers exp=0)', async () => {
    const p = new URLSearchParams({ harness: 'h', role: 'worker', spawn: 's1' });
    await signSpawnParams(p); // permanent
    p.set('role', 'operator');
    expect(await verifySpawnParams(urlFrom(p))).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('a positive ttlSec still mints a bounded, expirable URL', async () => {
    const p = new URLSearchParams({ harness: 'h', role: 'worker' });
    const { exp } = await signSpawnParams(p, { nowMs: 1_000_000_000_000, ttlSec: 3600 });
    expect(exp).toBe(Math.floor(1_000_000_000_000 / 1000) + 3600);
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

// ── WI-3190: rotation-strand detection, blast radius, self-recovery guidance ──
//
// A key rotation is a coarse revocation — every in-flight signed URL fails its
// NEXT verify with `invalid_signature`, byte-identical to a role-escalation
// attempt. These cover the pure logic that tells an operational strand from an
// attack, dedupes the alert, reports a rotate's blast radius, and hands the
// stranded agent actionable recovery text. No crypto behaviour is changed.
describe('verified-spawn tracker + strand classification (WI-3190)', () => {
  beforeEach(() => _resetVerifiedSpawns());

  it('a never-verified spawn cannot be a strand (an attack signature, not a rotation)', () => {
    expect(classifyAndConsumeFailure('invalid_signature', 's-forged')).toBe('unverified');
  });

  it('recordVerifiedSpawn is a no-op for a null / undefined / empty spawn', () => {
    recordVerifiedSpawn({ spawn: null });
    recordVerifiedSpawn({ spawn: undefined });
    recordVerifiedSpawn({ spawn: '' });
    expect(classifyAndConsumeFailure('invalid_signature', 's-x')).toBe('unverified');
  });

  it('classifies a post-verify signature failure for a known spawn as a rotation_strand', () => {
    recordVerifiedSpawn({ spawn: 's-1', role: 'worker', harness: 'h', nowMs: 1000 });
    expect(classifyAndConsumeFailure('invalid_signature', 's-1')).toBe('rotation_strand');
  });

  it('treats expiry of a previously-verified spawn as a strand as well', () => {
    recordVerifiedSpawn({ spawn: 's-1', nowMs: 1000 });
    expect(classifyAndConsumeFailure('expired', 's-1')).toBe('rotation_strand');
  });

  it('a failure for a DIFFERENT (never-verified) spawn stays unverified', () => {
    recordVerifiedSpawn({ spawn: 's-known', nowMs: 1000 });
    expect(classifyAndConsumeFailure('invalid_signature', 's-forged')).toBe('unverified');
  });

  it('consumes the strand signal — the SECOND failure for the same dead spawn no longer alerts', () => {
    recordVerifiedSpawn({ spawn: 's-1', nowMs: 1000 });
    expect(classifyAndConsumeFailure('invalid_signature', 's-1')).toBe('rotation_strand');
    expect(classifyAndConsumeFailure('invalid_signature', 's-1')).toBe('unverified'); // deduped
  });

  it('a non-revocation reason never strand-classifies AND does not consume the known spawn', () => {
    recordVerifiedSpawn({ spawn: 's-1', nowMs: 1000 });
    expect(classifyAndConsumeFailure('missing_sig', 's-1')).toBe('unverified');
    // still tracked: a later genuine revocation failure is still a strand
    expect(classifyAndConsumeFailure('invalid_signature', 's-1')).toBe('rotation_strand');
  });

  it('re-recording the same spawn refreshes it without duplicating (still one strand)', () => {
    recordVerifiedSpawn({ spawn: 's-1', nowMs: 1000 });
    recordVerifiedSpawn({ spawn: 's-1', nowMs: 2000 });
    expect(classifyAndConsumeFailure('invalid_signature', 's-1')).toBe('rotation_strand');
    expect(classifyAndConsumeFailure('invalid_signature', 's-1')).toBe('unverified');
  });
});

describe('rotateSpawnSigningKey blast-radius report (WI-3190)', () => {
  beforeEach(() => {
    _resetVerifiedSpawns();
    _resetSpawnSigningKeyCache();
  });

  it('reports zero invalidated spawns when this process verified none', async () => {
    const r = await rotateSpawnSigningKey();
    expect(r.invalidatedSpawnCount).toBe(0);
    expect(r.invalidatedSpawns).toEqual([]);
    expect(typeof r.rotatedAt).toBe('string');
  });

  it('enumerates just-invalidated spawns most-recent-first, without clearing the tracker', async () => {
    // rotate deliberately logs the blast radius loudly — assert it (and silence
    // the console so vitest-fail-on-console doesn't flag the intentional warn).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recordVerifiedSpawn({ spawn: 's-old', role: 'worker', harness: 'h', nowMs: 1000 });
      recordVerifiedSpawn({ spawn: 's-new', role: 'cup', harness: 'papercusp', nowMs: 5000 });
      const r = await rotateSpawnSigningKey();
      expect(r.invalidatedSpawnCount).toBe(2);
      expect(r.invalidatedSpawns.map((s) => s.spawn)).toEqual(['s-new', 's-old']); // recency desc
      expect(r.invalidatedSpawns[0]).toMatchObject({
        spawn: 's-new',
        role: 'cup',
        harness: 'papercusp',
      });
      // the loud blast-radius log is the whole point — it must have fired.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[spawn-signing][ROTATE]'));
      // rotate must NOT clear the set — each stranded spawn's next failing call
      // is still recognisable as a strand rather than an attack.
      expect(classifyAndConsumeFailure('invalid_signature', 's-new')).toBe('rotation_strand');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('spawnSigFailureGuidance (WI-3190)', () => {
  it('gives revocation-specific recovery for invalid_signature and expired', () => {
    for (const reason of ['invalid_signature', 'expired']) {
      const g = spawnSigFailureGuidance(reason);
      expect(g).toMatch(/mcp-call\.mjs/);
      expect(g).toMatch(/re-?spawn/i);
    }
  });

  it('covers the missing-signature family and an unknown reason with actionable text', () => {
    expect(spawnSigFailureGuidance('missing_sig')).toMatch(/mcp-call\.mjs/);
    expect(spawnSigFailureGuidance('missing_sig_required_mode')).toMatch(/mcp-call\.mjs/);
    expect(spawnSigFailureGuidance('something_unexpected')).toMatch(/mcp-call\.mjs/);
  });
});
