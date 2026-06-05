import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-trust-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe.skip('trust store (needs PG fixture)', () => {
  it('starts empty', async () => {
    const m = await import('./trust-store');
    const store = await m.readTrustStore();
    expect(store.entries).toEqual([]);
    expect(store.rotations).toEqual([]);
    expect(store.blocklist).toEqual([]);
  });

  it('records and checks trust', async () => {
    const m = await import('./trust-store');
    await m.recordTrust({
      publisher: '@papercupai',
      plugin: 'aws-lambda',
      publisherKeyFingerprint: 'SHA256:abc',
      scriptHash: 'sha256:s1',
    });
    const r = await m.checkTrust({
      publisher: '@papercupai',
      plugin: 'aws-lambda',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'SHA256:abc',
    });
    expect(r.trusted).toBe(true);
  });

  it('returns no-trust for unknown plugin', async () => {
    const m = await import('./trust-store');
    const r = await m.checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('no-trust');
  });

  it('rejects when fingerprint differs (key-rotated)', async () => {
    const m = await import('./trust-store');
    await m.recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'old',
      scriptHash: 'sha256:s1',
    });
    const r = await m.checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'new',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('key-rotated');
  });

  it('rejects unapproved scriptHash even when publisher is trusted', async () => {
    const m = await import('./trust-store');
    await m.recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'fp',
      scriptHash: 'sha256:old',
    });
    const r = await m.checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:new',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('script-not-approved');
  });

  it('blocklist rejects regardless of trust', async () => {
    const m = await import('./trust-store');
    await m.recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'fp',
      scriptHash: 'sha256:s1',
    });
    await m.blocklistFingerprint('fp');
    const r = await m.checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('blocklisted');
  });

  it('replaces approved hashes when fingerprint changes', async () => {
    const m = await import('./trust-store');
    await m.recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'old',
      scriptHash: 'sha256:s1',
    });
    await m.recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'new',
      scriptHash: 'sha256:s2',
    });
    const store = await m.readTrustStore();
    const e = store.entries[0];
    expect(e.publisherKeyFingerprint).toBe('new');
    expect(e.approvedScriptHashes).toEqual(['sha256:s2']);
  });

  it('revokeTrust drops the entry', async () => {
    const m = await import('./trust-store');
    await m.recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'fp',
      scriptHash: 'sha256:s1',
    });
    await m.revokeTrust('X', 'Y');
    const r = await m.checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('no-trust');
  });

  it('records key-rotation events', async () => {
    const m = await import('./trust-store');
    await m.recordKeyRotation({
      publisher: '@papercupai',
      oldFingerprint: 'old',
      newFingerprint: 'new',
      rotatedAt: '2026-05-12T00:00:00Z',
      countersigned: true,
      reason: 'scheduled',
    });
    const store = await m.readTrustStore();
    expect(store.rotations).toHaveLength(1);
    expect(store.rotations[0].countersigned).toBe(true);
  });
});
