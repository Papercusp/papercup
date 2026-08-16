/**
 * WI-39447 — falsifiability discipline for this suite.
 *
 * The subject is a MODULE we import, so the controls are permanent fixtures in this file
 * (CLAUDE.md tier 1): a `verifyAlwaysOk` stand-in that would let any corruption through, and a
 * `verifyAlwaysBad` one that rejects everything. A healthy-seed calibration case runs against
 * the same code path, so the controls cannot all pass by the guard simply never firing.
 * Nothing here mutates the shared tree, and no probe touches the real seed dir.
 */

import { describe, it, expect } from 'vitest';
import {
  judgeSeedPayloadIntegrity,
  assertSeedPayloadMatchesManifest,
  type SeedStoreVerifier,
} from './seed-payload-integrity-guard';
import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';

const corestoreEntry: SeedStoreEntry = {
  kind: 'corestore',
  hash: '13b280d77c08235a4b01c41c31d9279050b98d9d4fb23d6dd6ca17e01d812756',
  sizeBytes: 318_544_683,
  source: { type: 'resource', path: 'corestore' },
  meta: { coreKeys: ['94fa049f'], coreLengths: { '94fa049f': 76 } },
} as unknown as SeedStoreEntry;

const gitEntry: SeedStoreEntry = {
  kind: 'git',
  hash: '83f17da05eccbaab9a996b037837d7959263d10900b2b61bdb9b993d26b9f277',
  sizeBytes: 128_593_195,
  source: { type: 'resource', path: 'git' },
} as unknown as SeedStoreEntry;

const manifest = (stores: SeedStoreEntry[]): SeedManifest =>
  ({ seedFormatVersion: 1, potId: 'papercusp', cutAtEpoch: 1, cutTs: 1786823780234, stores }) as unknown as SeedManifest;

/** CONTROL: a verifier that never objects — the pre-fix world, where nothing measured bytes. */
const verifyAlwaysOk: SeedStoreVerifier = async () => ({ ok: true });

/** CONTROL: a verifier that always objects. */
const verifyAlwaysBad: SeedStoreVerifier = async () => ({ ok: false, reason: 'synthetic rejection' });

/** The real defect, reproduced through the injected seam: the shipped 2026-08-15 mismatch. */
const verifyRealMismatch: SeedStoreVerifier = async (entry) =>
  entry.kind === 'corestore'
    ? { ok: false, reason: 'hash mismatch (expected 13b280d77c08…, got fa4fddc22e97…)' }
    : { ok: true };

describe('seed payload integrity guard (WI-39447)', () => {
  it('CALIBRATION — passes a seed whose stores all verify (the guard is not vacuously red)', async () => {
    const res = await judgeSeedPayloadIntegrity({
      manifest: manifest([gitEntry, corestoreEntry]),
      dir: '/seed',
      origin: 'reuse',
      verify: verifyAlwaysOk,
    });
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
    expect(res.checked).toEqual(['git', 'corestore']);
  });

  it('CATCHES the shipped 2026-08-15 defect: a grafted corestore whose hash describes absent bytes', async () => {
    const res = await judgeSeedPayloadIntegrity({
      manifest: manifest([gitEntry, corestoreEntry]),
      dir: '/seed',
      origin: 'reuse',
      verify: verifyRealMismatch,
    });
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.kind).toBe('corestore');
    expect(res.findings[0]?.reason).toContain('hash mismatch');
    // The git store still verified — the guard must not smear one store's failure over the others.
    expect(res.checked).toContain('git');
  });

  it('CONTROL — the SAME manifest passes under a verifier that measures nothing', async () => {
    // This is the pre-fix behaviour, kept permanently: if this ever goes red, the guard has
    // started rejecting on something other than the verifier's verdict.
    const res = await judgeSeedPayloadIntegrity({
      manifest: manifest([gitEntry, corestoreEntry]),
      dir: '/seed',
      origin: 'reuse',
      verify: verifyAlwaysOk,
    });
    expect(res.ok).toBe(true);
  });

  it('names the GRAFT as the cause and forbids recomputing, on a reuse cut', async () => {
    const res = await judgeSeedPayloadIntegrity({
      manifest: manifest([corestoreEntry]),
      dir: '/seed',
      origin: 'reuse',
      verify: verifyRealMismatch,
    });
    expect(res.message).toContain('--reuse-corestore');
    expect(res.message).toContain('do NOT');
    expect(res.message).toMatch(/recomput/i);
  });

  it('gives a DIFFERENT remedy on a fresh cut (post-cut mutation, not an inherited entry)', async () => {
    const res = await judgeSeedPayloadIntegrity({
      manifest: manifest([corestoreEntry]),
      dir: '/seed',
      origin: 'fresh',
      verify: verifyRealMismatch,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('fresh cut');
    expect(res.message).not.toContain('--reuse-corestore');
  });

  it('resolves a RELATIVE payload path against the seed dir, and leaves an absolute one alone', async () => {
    const seen: string[] = [];
    const spy: SeedStoreVerifier = async (_e, p) => {
      seen.push(p);
      return { ok: true };
    };
    const absolute = { ...corestoreEntry, source: { type: 'resource', path: '/elsewhere/corestore' } } as SeedStoreEntry;
    await judgeSeedPayloadIntegrity({
      manifest: manifest([gitEntry, absolute]),
      dir: '/seed',
      origin: 'fresh',
      verify: spy,
    });
    expect(seen).toEqual(['/seed/git', '/elsewhere/corestore']);
  });

  it('REFUSES a store it cannot measure rather than skipping it silently', async () => {
    const unmeasurable = { kind: 'corestore', hash: 'abc', sizeBytes: 1, source: {} } as unknown as SeedStoreEntry;
    const res = await judgeSeedPayloadIntegrity({
      manifest: manifest([unmeasurable]),
      dir: '/seed',
      origin: 'reuse',
      verify: verifyAlwaysOk,
    });
    expect(res.ok).toBe(false);
    expect(res.findings[0]?.reason).toContain('cannot be measured');
    // ...and it is reported as NOT checked, so `checked` never overstates coverage.
    expect(res.checked).not.toContain('corestore');
  });

  it('an empty store list cannot pass as "verified" — coverage is reported honestly', async () => {
    const res = await judgeSeedPayloadIntegrity({
      manifest: manifest([]),
      dir: '/seed',
      origin: 'fresh',
      verify: verifyAlwaysBad,
    });
    expect(res.ok).toBe(true);
    expect(res.checked).toEqual([]);
    expect(res.message).toContain('no stores');
  });

  it('the asserting form THROWS on a mismatch and returns the result when clean', async () => {
    await expect(
      assertSeedPayloadMatchesManifest({
        manifest: manifest([corestoreEntry]),
        dir: '/seed',
        origin: 'reuse',
        verify: verifyRealMismatch,
      }),
    ).rejects.toThrow(/REFUSING a seed whose manifest does not describe its payload/);

    const logged: string[] = [];
    const ok = await assertSeedPayloadMatchesManifest({
      manifest: manifest([corestoreEntry]),
      dir: '/seed',
      origin: 'reuse',
      verify: verifyAlwaysOk,
      log: (m) => logged.push(m),
    });
    expect(ok.ok).toBe(true);
    expect(logged.join('\n')).toContain('payload integrity OK');
  });
});
