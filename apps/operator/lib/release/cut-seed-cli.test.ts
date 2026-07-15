/**
 * cut-seed-cli.test.ts — the git-seal key-selection branch of the seed cutter CLI
 * (plan hive-seed-bundle-2026-07-04 P-010 live-wire 2 completion). Pure: `deriveEpochKey`
 * is injected, so the correctness-critical branch (which keyRef + key seals the git
 * bundle) is verified with no keychain / native crypto / real hive. The full cut (git +
 * corestore I/O + real deriveEpochKey on the owner keychain) is owner-box/build-dependent
 * and out of scope for a headless unit test — only the branch selection is tested here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseGitDepth,
  pickGitEncryption,
  assertEpochSealIdentityPresent,
  encodeEpochKeysFile,
  collectSeedEpochKeys,
  graftCorestoreEntry,
  refreshCorestoreStateForSeed,
  readReusableCorestore,
  isCorestoreLockedError,
  waitForOperatorDrain,
} from './cut-seed-cli';
import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';

const EPOCH_KEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256));
const HEX32 = 'ab'.repeat(32); // 64 hex chars = 32 bytes

describe('pickGitEncryption', () => {
  it('explicit keyHex ⇒ FIXTURE mode: seals via=seed-key-op with that key, never touches deriveEpochKey', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({
      keyHex: HEX32,
      epochProvided: false,
      hive: 'papercusp',
      cutAtEpoch: 0,
      deriveEpochKey,
    });
    expect(enc?.keyRef).toEqual({ via: 'seed-key-op', potId: 'papercusp' });
    expect(enc?.key).toEqual(Uint8Array.from(Buffer.from(HEX32, 'hex')));
    expect(deriveEpochKey).not.toHaveBeenCalled(); // explicit key wins; no crypto touched
  });

  it('a bad-length keyHex ⇒ throws (32-byte requirement)', async () => {
    await expect(
      pickGitEncryption({ keyHex: 'abcd', epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey: vi.fn(async () => EPOCH_KEY) }),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it('a live --workspace-id ⇒ RELEASE mode: seals via=epoch with the owner epoch key at cutAtEpoch', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({
      workspaceId: 'papercusp-workspace',
      epochProvided: false,
      hive: 'papercusp',
      cutAtEpoch: 3,
      deriveEpochKey,
    });
    expect(enc?.keyRef).toEqual({ via: 'epoch', potId: 'papercusp', epoch: 3 });
    expect(enc?.key).toEqual(EPOCH_KEY);
    expect(deriveEpochKey).toHaveBeenCalledWith('papercusp', 3);
  });

  it('an explicit --epoch (no workspace) also takes the epoch path', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({ epochProvided: true, hive: 'papercusp', cutAtEpoch: 5, deriveEpochKey });
    expect(enc?.keyRef).toEqual({ via: 'epoch', potId: 'papercusp', epoch: 5 });
    expect(deriveEpochKey).toHaveBeenCalledWith('papercusp', 5);
  });

  it('no key + no epoch context ⇒ PLAINTEXT (undefined), never mints from the bare cutAtEpoch=0 guess', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const warn = vi.fn();
    const enc = await pickGitEncryption({ epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey, warn });
    expect(enc).toBeUndefined();
    expect(deriveEpochKey).not.toHaveBeenCalled(); // guarded: never mint a divergent key from nothing
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PLAINTEXT/));
  });

  it('a wrong-size epoch key from deriveEpochKey ⇒ throws (fail closed, never seal with a bad key)', async () => {
    const deriveEpochKey = vi.fn(async () => Uint8Array.from([1, 2, 3]));
    await expect(
      pickGitEncryption({ workspaceId: 'ws', epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey }),
    ).rejects.toThrow(/expected 32/);
  });
});

describe('assertEpochSealIdentityPresent (load-don\'t-mint guard, WI-2903/WI-1981)', () => {
  const base = { workspaceId: 'papercusp-workspace', hive: 'papercusp', allowMint: false };

  it('identity present ⇒ proceeds (and names the pubkey in the warn)', async () => {
    const warn = vi.fn();
    await expect(
      assertEpochSealIdentityPresent({ ...base, warn, loadStatus: async () => ({ kind: 'ok', pubkeyBase64: 'dt7o6ioLxyz' }) }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dt7o6ioL/));
  });

  it('identity ABSENT ⇒ refuses: deriveEpochKey is get-or-create, sealing here would mint a divergent key', async () => {
    await expect(
      assertEpochSealIdentityPresent({ ...base, loadStatus: async () => ({ kind: 'not_found' }) }),
    ).rejects.toThrow(/REFUSING epoch seal.*NO private key/s);
  });

  it('keychain read ERROR ⇒ fails CLOSED (a key may exist but be unreadable — not the same as absent)', async () => {
    await expect(
      assertEpochSealIdentityPresent({ ...base, loadStatus: async () => ({ kind: 'error', reason: 'secret-tool timeout' }) }),
    ).rejects.toThrow(/keychain read FAILED \(secret-tool timeout\)/);
  });

  it('--allow-mint-epoch-key ⇒ proceeds on absent identity (new-hive bootstrap escape hatch), loudly', async () => {
    const warn = vi.fn();
    await expect(
      assertEpochSealIdentityPresent({ ...base, allowMint: true, warn, loadStatus: async () => ({ kind: 'not_found' }) }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WILL mint/));
  });
});

describe('parseGitDepth', () => {
  it('--shallow aliases to --depth 1', () => {
    expect(parseGitDepth({ shallow: true })).toBe(1);
  });

  it('--depth 1 is accepted and omitted depth stays undefined', () => {
    expect(parseGitDepth({ depth: '1' })).toBe(1);
    expect(parseGitDepth({})).toBeUndefined();
  });

  it('rejects invalid or unsupported depths', () => {
    expect(() => parseGitDepth({ depth: '0' })).toThrow(/positive integer/);
    expect(() => parseGitDepth({ depth: '2' })).toThrow(/only 1/);
    expect(() => parseGitDepth({ shallow: true, depth: '2' })).toThrow(/alias/);
  });
});

describe('refreshCorestoreStateForSeed', () => {
  it('force-backfills current rows and drains until empty before a corestore cut', async () => {
    const pg = {} as never;
    const ownLog = {
      keyHex: 'cd'.repeat(32),
      append: vi.fn(async () => {}),
      appendBatch: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      length: 0,
    };
    const backfillImpl = vi.fn(async () => ({ skipped: false, enqueued: 12, dropped: 0 }));
    const drainImpl = vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(5).mockResolvedValueOnce(0);
    const warn = vi.fn();

    const res = await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace',
      hive: 'papercusp',
      store: {} as never,
      pg,
      openOwnLogImpl: async () => ownLog,
      backfillImpl,
      drainImpl,
      warn,
    });

    expect(backfillImpl).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', ownLog }),
      pg,
      { force: true, maxOpsPerAuthor: 0 },
    );
    expect(drainImpl).toHaveBeenCalledTimes(3);
    expect(res).toEqual({
      backfill: { skipped: false, enqueued: 12, dropped: 0 },
      drained: 12,
      passes: 3,
      ownLogKey: ownLog.keyHex,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refreshed corestore source'));
  });

  it('P-004: does NOT append a fresh head snapshot for a FULL cut (sparse falsy)', async () => {
    const ownLog = { keyHex: 'cd'.repeat(32), append: vi.fn(async () => {}), appendBatch: vi.fn(async () => {}), get: vi.fn(async () => null), length: 0 };
    const produceSnapshotImpl = vi.fn();
    await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace',
      hive: 'papercusp',
      store: {} as never,
      pg: {} as never,
      openOwnLogImpl: async () => ownLog,
      backfillImpl: vi.fn(async () => ({ skipped: false, enqueued: 0, dropped: 0 })),
      drainImpl: vi.fn(async () => 0),
      produceSnapshotImpl,
      warn: vi.fn(),
      // sparse omitted → full cut
    });
    expect(produceSnapshotImpl).not.toHaveBeenCalled();
  });

  it('P-004: appends a fresh head snapshot AFTER the drain when sparse (so the sparse start is in the reader scan window)', async () => {
    const ownLog = { keyHex: 'cd'.repeat(32), append: vi.fn(async () => {}), appendBatch: vi.fn(async () => {}), get: vi.fn(async () => null), length: 0 };
    const drainImpl = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const produceSnapshotImpl = vi.fn(async () => ({ appended: true, coversUpTo: 42, rowCount: 10, chunkCount: 2 }));
    const warn = vi.fn();
    await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace',
      hive: 'papercusp',
      store: {} as never,
      pg: {} as never,
      openOwnLogImpl: async () => ownLog,
      backfillImpl: vi.fn(async () => ({ skipped: false, enqueued: 3, dropped: 0 })),
      drainImpl,
      produceSnapshotImpl,
      warn,
      sparse: true,
    });
    expect(produceSnapshotImpl).toHaveBeenCalledTimes(1);
    expect(produceSnapshotImpl).toHaveBeenCalledWith(ownLog, expect.objectContaining({ now: expect.any(Number), schemaVersion: expect.any(Number) }));
    // Drain fully first, THEN snapshot: the snapshot must compact the drained state.
    expect(drainImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('appended fresh head snapshot'));
  });
});

// --- WI-3232: offline-pot cutter helpers ---

const GIT_ENTRY: SeedStoreEntry = {
  kind: 'git',
  hash: 'gh1',
  sizeBytes: 100,
  source: { type: 'resource', path: 'git' },
  encryption: { scheme: 'xchacha20poly1305', keyRef: { via: 'epoch', potId: 'papercusp', epoch: 0 } },
};
const CORESTORE_ENTRY: SeedStoreEntry = {
  kind: 'corestore',
  hash: 'ch1',
  sizeBytes: 2048,
  source: { type: 'resource', path: 'corestore' },
};
function manifest(stores: SeedStoreEntry[], cutAtEpoch = 0): SeedManifest {
  return { seedFormatVersion: 1, potId: 'papercusp', cutAtEpoch, cutHlc: '0:0', cutTs: 1, stores };
}

describe('encodeEpochKeysFile (WI-3232 bundled epoch keys, WI-3297 multi-epoch)', () => {
  const key = (fill: number) => Uint8Array.from(Array.from({ length: 32 }, () => fill));

  it('serializes { hive: { epoch: base64 } } for a 32-byte key', () => {
    const k = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
    const out = JSON.parse(encodeEpochKeysFile('papercusp', new Map([[0, k]])));
    expect(out).toEqual({ papercusp: { '0': Buffer.from(k).toString('base64') } });
    // round-trips back to the exact 32 bytes
    expect(Uint8Array.from(Buffer.from(out.papercusp['0'], 'base64'))).toEqual(k);
  });
  it('serializes MULTIPLE epochs under one hive, epoch-sorted', () => {
    const out = JSON.parse(
      encodeEpochKeysFile('papercusp', new Map([[2, key(2)], [0, key(0)], [1, key(1)]])),
    );
    expect(Object.keys(out.papercusp)).toEqual(['0', '1', '2']);
    expect(out.papercusp['2']).toBe(Buffer.from(key(2)).toString('base64'));
  });
  it('rejects a non-32-byte key (never ship a truncated seal key)', () => {
    expect(() => encodeEpochKeysFile('papercusp', new Map([[0, new Uint8Array(16)]]))).toThrow(/32 bytes/);
  });
  it('rejects an empty map (an empty file would silently defer every op)', () => {
    expect(() => encodeEpochKeysFile('papercusp', new Map())).toThrow(/no epoch keys/);
  });
});

describe('collectSeedEpochKeys (WI-3297 historical-epoch bundling)', () => {
  const key = (fill: number) => Uint8Array.from(Array.from({ length: 32 }, () => fill));

  it('bundles the current key plus every keychain-present historical epoch (load-only)', async () => {
    const loadKey = vi.fn(async (_h: string, epoch: number) => (epoch === 1 ? null : key(epoch)));
    const warn = vi.fn();
    const keys = await collectSeedEpochKeys({ hive: 'papercusp', cutAtEpoch: 3, currentKey: key(9), loadKey, warn });
    expect([...keys.keys()].sort((a, b) => a - b)).toEqual([0, 2, 3]);
    expect(keys.get(3)).toEqual(key(9)); // current epoch = the seal-derived key, never re-loaded
    expect(loadKey.mock.calls.map(([, e]) => e)).toEqual([0, 1, 2]); // never touches cutAtEpoch
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/epoch 1 key NOT in the keychain/);
  });
  it('cutAtEpoch 0 bundles exactly the current key with no keychain reads', async () => {
    const loadKey = vi.fn();
    const keys = await collectSeedEpochKeys({ hive: 'papercusp', cutAtEpoch: 0, currentKey: key(7), loadKey });
    expect([...keys.entries()]).toEqual([[0, key(7)]]);
    expect(loadKey).not.toHaveBeenCalled();
  });
  it('propagates a loader failure (unreadable ≠ absent — fail closed)', async () => {
    const loadKey = vi.fn(async () => {
      throw new Error('keychain read FAILED');
    });
    await expect(
      collectSeedEpochKeys({ hive: 'papercusp', cutAtEpoch: 1, currentKey: key(1), loadKey, warn: () => {} }),
    ).rejects.toThrow(/keychain read FAILED/);
  });
});

describe('graftCorestoreEntry (WI-3232 --reuse-corestore)', () => {
  it('appends the corestore entry to a git-only manifest', () => {
    const grafted = graftCorestoreEntry(manifest([GIT_ENTRY]), CORESTORE_ENTRY);
    expect(grafted.stores.map((s) => s.kind)).toEqual(['git', 'corestore']);
    expect(grafted.stores[1]).toEqual(CORESTORE_ENTRY);
    expect(grafted.potId).toBe('papercusp'); // preserves the rest of the manifest
  });
  it('refuses to double-add a corestore', () => {
    expect(() => graftCorestoreEntry(manifest([GIT_ENTRY, CORESTORE_ENTRY]), CORESTORE_ENTRY)).toThrow(/already has a corestore/);
  });
});

describe('readReusableCorestore (WI-3232 --reuse-corestore)', () => {
  const okExists = () => true;
  it('returns the corestore entry + epoch from an existing seed manifest', async () => {
    const readManifest = vi.fn(async () => JSON.stringify(manifest([GIT_ENTRY, CORESTORE_ENTRY], 0)));
    const res = await readReusableCorestore('/seed', { readManifest, exists: okExists });
    expect(res.entry).toEqual(CORESTORE_ENTRY);
    expect(res.cutAtEpoch).toBe(0);
  });
  it('throws when the seed dir has no manifest', async () => {
    await expect(readReusableCorestore('/seed', { exists: (p) => !p.endsWith('manifest.json') })).rejects.toThrow(/no manifest.json/);
  });
  it('throws when the manifest has no corestore entry (nothing to reuse)', async () => {
    const readManifest = vi.fn(async () => JSON.stringify(manifest([GIT_ENTRY])));
    await expect(readReusableCorestore('/seed', { readManifest, exists: okExists })).rejects.toThrow(/no 'corestore' store entry/);
  });
  it('throws when the corestore payload dir is missing on disk', async () => {
    const readManifest = vi.fn(async () => JSON.stringify(manifest([GIT_ENTRY, CORESTORE_ENTRY])));
    const exists = (p: string) => !p.endsWith('corestore');
    await expect(readReusableCorestore('/seed', { readManifest, exists })).rejects.toThrow(/is missing on disk/);
  });
});

describe('isCorestoreLockedError (WI-4487)', () => {
  it('recognises the real fd-lock message a live operator produces', () => {
    // The exact string fd-lock throws (fd-lock/index.js) when the operator holds the
    // CORESTORE device file — the signature that we must fall back to a read-only open.
    expect(isCorestoreLockedError(new Error('File descriptor could not be locked'))).toBe(true);
  });

  it('does NOT swallow unrelated open failures (they must keep propagating)', () => {
    expect(isCorestoreLockedError(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isCorestoreLockedError(new Error('Unsupported version: 3'))).toBe(false);
  });
});

describe('waitForOperatorDrain (WI-4487 — the operator owns the log append)', () => {
  const base = { workspaceId: 'ws-1', hive: 'papercusp' };

  /** Minimal postgres.Sql stand-in: each call returns the next queued undrained count. */
  const pgReturning = (counts: number[]) => {
    const calls = { n: 0 };
    const sql = (async () => [{ undrained: counts[Math.min(calls.n++, counts.length - 1)] }]) as never;
    return { sql, calls };
  };

  it('returns immediately when the operator has already drained to zero', async () => {
    const { sql, calls } = pgReturning([0]);
    const res = await waitForOperatorDrain({ ...base, pg: sql, warn: () => {} });
    expect(res.undrained).toBe(0);
    expect(calls.n).toBe(1);
  });

  it('waits for the live operator to drain the rows backfill enqueued, then proceeds', async () => {
    const { sql, calls } = pgReturning([7, 3, 0]);
    const sleep = vi.fn(async () => {});
    const res = await waitForOperatorDrain({ ...base, pg: sql, sleep, warn: () => {} });
    expect(res.undrained).toBe(0);
    expect(calls.n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('keeps waiting while the backlog SHRINKS, however long it takes (a real backfill is ~8k rows)', async () => {
    // Regression: a fixed total budget failed a perfectly healthy cut. ~8k rows drain at
    // ~55 rows/s ≈ 145s live, so elapsed time alone must never end the wait.
    const { sql } = pgReturning([8000, 6000, 4000, 2000, 0]);
    let t = 0;
    const res = await waitForOperatorDrain({
      ...base,
      pg: sql,
      stallMs: 120_000,
      now: () => (t += 60_000), // 60s per poll => 240s total elapsed, far past any fixed budget
      sleep: async () => {},
      warn: () => {},
    });
    expect(res.undrained).toBe(0); // progress, so we waited it out rather than falsely failing
  });

  it('REFUSES to cut a seed that would silently omit rows when the operator STALLS', async () => {
    const { sql } = pgReturning([5]); // stuck at 5 — no progress
    let t = 0;
    await expect(
      waitForOperatorDrain({
        ...base,
        pg: sql,
        stallMs: 1_000,
        now: () => (t += 600),
        sleep: async () => {},
        warn: () => {},
      }),
    ).rejects.toThrow(/NO progress draining 5 outbox row\(s\).*refusing to cut/s);
  });

  it('explains that the cut cannot drain on the operator\u2019s behalf (the data-loss trap)', async () => {
    const { sql } = pgReturning([2]);
    let t = 0;
    await expect(
      waitForOperatorDrain({ ...base, pg: sql, stallMs: 10, now: () => (t += 100), sleep: async () => {}, warn: () => {} }),
    ).rejects.toThrow(/cannot drain on its behalf without corrupting delivery state/);
  });
});
