/**
 * deferred-git-restore.test.ts — the post-admission git-restore trigger (P-010
 * live-wire 2). Pure/hermetic: the epoch-key provider, manifest read, and restore
 * are all injected, so the whole decision matrix runs with no PG, no real join, no
 * git/corestore. Proves: via='epoch' resolves through the provider; not-yet-held /
 * removed-member / no-provider / seed-key-op all DEFER (null, never throw); and the
 * trigger re-restores the decryptable store SCOPED to its kind, fail-soft.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SeedManifest } from '@papercusp/seed-bundle';
import type { EpochKey } from './hive-epoch-crypto';
import type { EpochKeyProvider } from './hive-epoch-serving';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';
import { resolveSeedDecryptionKey, triggerDeferredGitRestore } from './deferred-git-restore';
import type { RestoreHiveSeedCtx, RestoreHiveSeedResult } from './restore-hive-seed';

const KEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));

/** A provider that hands back a fixed epoch key. */
function providerWith(key: Uint8Array): EpochKeyProvider {
  return { keyForEpoch: vi.fn(async () => key as EpochKey) };
}
/** A provider that fails closed with the given error. */
function providerThrowing(err: Error): EpochKeyProvider {
  return { keyForEpoch: vi.fn(async () => { throw err; }) };
}

/** A manifest with a corestore store + an encrypted git store (via='epoch'). */
function manifestWithEncryptedGit(via: 'epoch' | 'seed-key-op' = 'epoch'): SeedManifest {
  return {
    seedFormatVersion: 1,
    hiveId: 'rig-hive',
    cutAtEpoch: 3,
    cutHlc: '0',
    cutTs: 1,
    stores: [
      { kind: 'corestore', hash: 'aa', sizeBytes: 10, source: { type: 'resource', path: 'corestore' } },
      {
        kind: 'git',
        hash: 'bb',
        sizeBytes: 20,
        source: { type: 'resource', path: 'git' },
        encryption: {
          scheme: 'chacha20-poly1305',
          keyRef: via === 'epoch' ? { via: 'epoch', hiveId: 'rig-hive', epoch: 3 } : { via: 'seed-key-op', hiveId: 'rig-hive' },
        },
      },
    ],
  };
}

const okRestore = (kind: string): RestoreHiveSeedResult => ({ ran: true, outcomes: [{ kind, ok: true }], deferred: [] });

describe('resolveSeedDecryptionKey', () => {
  it("via='epoch' ⇒ resolves the epoch key through the provider", async () => {
    const provider = providerWith(KEY);
    const key = await resolveSeedDecryptionKey({ via: 'epoch', hiveId: 'rig-hive', epoch: 3 }, { epochKeyProvider: provider });
    expect(key).toEqual(KEY);
    expect(provider.keyForEpoch).toHaveBeenCalledWith('rig-hive', 3);
  });

  it("via='epoch' + key not yet held (EpochKeyUnavailableError) ⇒ null (defer), never throws", async () => {
    const provider = providerThrowing(new EpochKeyUnavailableError('rig-hive', 3));
    const logs: string[] = [];
    const key = await resolveSeedDecryptionKey({ via: 'epoch', hiveId: 'rig-hive', epoch: 3 }, { epochKeyProvider: provider, log: (m) => logs.push(m) });
    expect(key).toBeNull();
    expect(logs.some((l) => /not yet held/.test(l))).toBe(true);
  });

  it("via='epoch' + an unexpected provider error ⇒ null (defer), never throws", async () => {
    const provider = providerThrowing(new Error('pg exploded'));
    const key = await resolveSeedDecryptionKey({ via: 'epoch', hiveId: 'rig-hive', epoch: 3 }, { epochKeyProvider: provider });
    expect(key).toBeNull();
  });

  it("via='epoch' + no provider wired ⇒ null (defer)", async () => {
    const key = await resolveSeedDecryptionKey({ via: 'epoch', hiveId: 'rig-hive', epoch: 3 }, {});
    expect(key).toBeNull();
  });

  it("via='seed-key-op' ⇒ null (no delivery path yet) + a log pointing at via='epoch'", async () => {
    const logs: string[] = [];
    const key = await resolveSeedDecryptionKey({ via: 'seed-key-op', hiveId: 'rig-hive' }, { epochKeyProvider: providerWith(KEY), log: (m) => logs.push(m) });
    expect(key).toBeNull();
    expect(logs.some((l) => /seed-key-op.*no post-admission delivery|use via='epoch'/.test(l))).toBe(true);
  });
});

describe('triggerDeferredGitRestore', () => {
  const dirs = { seedDir: '/seed', targetRepoDir: '/repo', targetStoreDir: '/store' };

  it('no manifest ⇒ a complete no-op (ran:false)', async () => {
    const restore = vi.fn();
    const res = await triggerDeferredGitRestore({ ...dirs, readManifest: async () => null, restore });
    expect(res).toEqual({ ran: false, restored: [], stillDeferred: [] });
    expect(restore).not.toHaveBeenCalled();
  });

  it('a manifest with NO encrypted store ⇒ no-op (nothing was deferred)', async () => {
    const plain: SeedManifest = {
      seedFormatVersion: 1, hiveId: 'h', cutAtEpoch: 0, cutHlc: '0', cutTs: 1,
      stores: [{ kind: 'corestore', hash: 'a', sizeBytes: 1, source: { type: 'resource', path: 'corestore' } }],
    };
    const restore = vi.fn();
    const res = await triggerDeferredGitRestore({ ...dirs, readManifest: async () => plain, restore });
    expect(res).toEqual({ ran: false, restored: [], stillDeferred: [] });
    expect(restore).not.toHaveBeenCalled();
  });

  it('key resolves ⇒ re-restores the git store SCOPED to onlyKinds:[git], with the key', async () => {
    const restore = vi.fn(async (_ctx: RestoreHiveSeedCtx) => okRestore('git'));
    const res = await triggerDeferredGitRestore({
      ...dirs,
      epochKeyProvider: providerWith(KEY),
      readManifest: async () => manifestWithEncryptedGit('epoch'),
      restore,
    });
    expect(res).toEqual({ ran: true, restored: ['git'], stillDeferred: [] });
    expect(restore).toHaveBeenCalledTimes(1);
    const arg = restore.mock.calls[0]![0];
    expect(arg.decryptionKey).toEqual(KEY);
    expect(arg.onlyKinds).toEqual(['git']);
    expect(arg.targetRepoDir).toBe('/repo');
  });

  it('key NOT yet available ⇒ store stays deferred, restore never called', async () => {
    const restore = vi.fn(async () => okRestore('git'));
    const res = await triggerDeferredGitRestore({
      ...dirs,
      epochKeyProvider: providerThrowing(new EpochKeyUnavailableError('rig-hive', 3)),
      readManifest: async () => manifestWithEncryptedGit('epoch'),
      restore,
    });
    expect(res).toEqual({ ran: true, restored: [], stillDeferred: ['git'] });
    expect(restore).not.toHaveBeenCalled();
  });

  it("seed-key-op keyRef ⇒ stays deferred (no delivery path), restore never called", async () => {
    const restore = vi.fn(async () => okRestore('git'));
    const res = await triggerDeferredGitRestore({
      ...dirs,
      epochKeyProvider: providerWith(KEY),
      readManifest: async () => manifestWithEncryptedGit('seed-key-op'),
      restore,
    });
    expect(res).toEqual({ ran: true, restored: [], stillDeferred: ['git'] });
    expect(restore).not.toHaveBeenCalled();
  });

  it('a restore that throws ⇒ fail-soft: store stays deferred, never throws', async () => {
    const restore = vi.fn(async () => { throw new Error('decrypt failed'); });
    const res = await triggerDeferredGitRestore({
      ...dirs,
      epochKeyProvider: providerWith(KEY),
      readManifest: async () => manifestWithEncryptedGit('epoch'),
      restore,
    });
    expect(res).toEqual({ ran: true, restored: [], stillDeferred: ['git'] });
  });

  it('a restore that reports the store not-ok ⇒ stays deferred (cold path)', async () => {
    const restore = vi.fn(async (): Promise<RestoreHiveSeedResult> => ({ ran: true, outcomes: [{ kind: 'git', ok: false, reason: 'decrypt' }], deferred: [] }));
    const res = await triggerDeferredGitRestore({
      ...dirs,
      epochKeyProvider: providerWith(KEY),
      readManifest: async () => manifestWithEncryptedGit('epoch'),
      restore,
    });
    expect(res).toEqual({ ran: true, restored: [], stillDeferred: ['git'] });
  });
});
