/**
 * seed-log-admission — WI-3288 offline-pot admission source. The contract under test:
 * the resolver returns EXACTLY the manifest's well-formed corestore coreKeys for a
 * hive-matched seed, and [] on EVERY degraded path (no/disabled seed, unreadable or
 * invalid manifest, hive mismatch, no corestore entry) — a boot must never fail (or
 * admit foreign logs) because of seed state.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveSeedLogAdmissions,
  resolveSeedLogKeys,
  validateSeedReplicaForAdmission,
} from './seed-log-admission';

const KEY_A = 'a'.repeat(64);
const KEY_B = '0123456789abcdef'.repeat(4).toUpperCase();

function manifestJson(opts: { potId?: string; stores?: unknown[] } = {}): string {
  return JSON.stringify({
    seedFormatVersion: 1,
    potId: opts.potId ?? 'papercusp',
    cutAtEpoch: 1,
    cutHlc: '001:00000:aa',
    cutTs: 1783385378879,
    stores: opts.stores ?? [
      {
        kind: 'git',
        hash: 'h1',
        sizeBytes: 10,
        source: { type: 'resource', path: 'git' },
      },
      {
        kind: 'corestore',
        hash: 'h2',
        sizeBytes: 20,
        source: { type: 'resource', path: 'corestore' },
        meta: { coreKeys: [KEY_A, KEY_B], coreLengths: { [KEY_A]: 5, [KEY_B]: 9 } },
      },
    ],
  });
}

function deps(raw: string | Error, seedDir: string | null = '/seed', disabled = false) {
  return {
    resolveSeedDirImpl: () => ({ seedDir, disabled }),
    readFileImpl: async (p: string) => {
      expect(p).toBe('/seed/manifest.json');
      if (raw instanceof Error) throw raw;
      return raw;
    },
  };
}

describe('resolveSeedLogKeys', () => {
  it('returns the corestore coreKeys (lowercased) for a hive-matched seed', async () => {
    const keys = await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(manifestJson()) });
    expect(keys).toEqual([KEY_A, KEY_B.toLowerCase()]);
  });

  it('returns [] on hive mismatch — a seed must never admit logs into another hive', async () => {
    const keys = await resolveSeedLogKeys({ potHomeSlug: 'calendar-app', ...deps(manifestJson()) });
    expect(keys).toEqual([]);
  });

  it('returns [] when no seed dir resolves / the seed is disabled', async () => {
    expect(await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(manifestJson(), null) })).toEqual([]);
    expect(
      await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(manifestJson(), '/seed', true) }),
    ).toEqual([]);
  });

  it('returns [] when the manifest is unreadable or invalid (fail-soft, never throws)', async () => {
    expect(
      await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(new Error('ENOENT')) }),
    ).toEqual([]);
    expect(await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps('not json') })).toEqual([]);
    expect(
      await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps('{"seedFormatVersion":99}') }),
    ).toEqual([]);
  });

  it('returns [] when the manifest has no corestore entry', async () => {
    const raw = manifestJson({
      stores: [{ kind: 'git', hash: 'h', sizeBytes: 1, source: { type: 'resource', path: 'g' } }],
    });
    expect(await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(raw) })).toEqual([]);
  });

  it('drops malformed key entries individually, keeping well-formed ones', async () => {
    const raw = manifestJson({
      stores: [
        {
          kind: 'corestore',
          hash: 'h',
          sizeBytes: 1,
          source: { type: 'resource', path: 'c' },
          meta: {
            coreKeys: [KEY_A, 'zz', 42, 'abc', null],
            coreLengths: { [KEY_A]: 5 },
          },
        },
      ],
    });
    expect(await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(raw) })).toEqual([KEY_A]);
  });

  it('requires a positive manifest length for every admitted key', async () => {
    const raw = manifestJson({
      stores: [
        {
          kind: 'corestore',
          hash: 'h',
          sizeBytes: 1,
          source: { type: 'resource', path: 'c' },
          meta: {
            coreKeys: [KEY_A, KEY_B],
            coreLengths: { [KEY_A]: 5, [KEY_B]: 0 },
          },
        },
      ],
    });
    expect(await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(raw) })).toEqual([KEY_A]);
  });

  it('carries cutter length and sparse-range provenance into boot admission', async () => {
    const raw = manifestJson({
      stores: [
        {
          kind: 'corestore',
          hash: 'h',
          sizeBytes: 1,
          source: { type: 'resource', path: 'c' },
          meta: {
            coreKeys: [KEY_A],
            coreLengths: { [KEY_A]: 103 },
            coreSparseFrom: { [KEY_A]: 77 },
          },
        },
      ],
    });
    expect(
      await resolveSeedLogAdmissions({ potHomeSlug: 'papercusp', ...deps(raw) }),
    ).toEqual([
      {
        keyHex: KEY_A,
        expectedLength: 103,
        shippedFrom: 77,
        seedDir: '/seed',
      },
    ]);
  });

  it('drops a key whose sparse start is outside its declared writer length', async () => {
    const raw = manifestJson({
      stores: [
        {
          kind: 'corestore',
          hash: 'h',
          sizeBytes: 1,
          source: { type: 'resource', path: 'c' },
          meta: {
            coreKeys: [KEY_A],
            coreLengths: { [KEY_A]: 103 },
            coreSparseFrom: { [KEY_A]: 103 },
          },
        },
      ],
    });
    expect(await resolveSeedLogKeys({ potHomeSlug: 'papercusp', ...deps(raw) })).toEqual([]);
  });
});

describe('validateSeedReplicaForAdmission', () => {
  const admission = {
    keyHex: KEY_A,
    expectedLength: 103,
    shippedFrom: 77,
    seedDir: '/seed',
  } as const;

  it('accepts a sparse replica only when the declared shipped range is local', async () => {
    await expect(
      validateSeedReplicaForAdmission(
        {
          keyHex: KEY_A,
          length: 103,
          contiguousLength: 0,
          has: async (index) => index >= 77 && index < 103,
        },
        admission,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects the observed stale seed-only shape: manifest length 103, local length 0', async () => {
    await expect(
      validateSeedReplicaForAdmission(
        {
          keyHex: KEY_A,
          length: 0,
          contiguousLength: 0,
          has: async () => false,
        },
        admission,
      ),
    ).resolves.toEqual({ ok: false, reason: 'local length 0 is below manifest length 103' });
  });

  it('rejects a header-only replica that knows the length but lacks shipped blocks', async () => {
    await expect(
      validateSeedReplicaForAdmission(
        {
          keyHex: KEY_A,
          length: 103,
          contiguousLength: 0,
          has: async () => false,
        },
        admission,
      ),
    ).resolves.toEqual({ ok: false, reason: 'shipped start block 77 is not present locally' });
  });

  // WI-10003092: Hypercore 11's `has` is async, so a sync read of it (`!!core.has(i)`) was
  // `!!Promise` — true for every block — and this guard admitted exactly the replica above.
  it('rejects a replica whose tail block is missing even though its start block is local', async () => {
    await expect(
      validateSeedReplicaForAdmission(
        {
          keyHex: KEY_A,
          length: 103,
          contiguousLength: 0,
          has: async (index) => index === 77,
        },
        admission,
      ),
    ).resolves.toEqual({ ok: false, reason: 'shipped tail block 102 is not present locally' });
  });
});
