/**
 * seed-log-admission — WI-3288 offline-pot admission source. The contract under test:
 * the resolver returns EXACTLY the manifest's well-formed corestore coreKeys for a
 * hive-matched seed, and [] on EVERY degraded path (no/disabled seed, unreadable or
 * invalid manifest, hive mismatch, no corestore entry) — a boot must never fail (or
 * admit foreign logs) because of seed state.
 */
import { describe, expect, it } from 'vitest';
import { resolveSeedLogKeys } from './seed-log-admission';

const KEY_A = 'a'.repeat(64);
const KEY_B = '0123456789abcdef'.repeat(4).toUpperCase();

function manifestJson(opts: { hiveId?: string; stores?: unknown[] } = {}): string {
  return JSON.stringify({
    seedFormatVersion: 1,
    hiveId: opts.hiveId ?? 'papercusp',
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
        meta: { coreKeys: [KEY_A, KEY_B], coreLengths: { [KEY_A]: 5 } },
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
    const keys = await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps(manifestJson()) });
    expect(keys).toEqual([KEY_A, KEY_B.toLowerCase()]);
  });

  it('returns [] on hive mismatch — a seed must never admit logs into another hive', async () => {
    const keys = await resolveSeedLogKeys({ hiveHomeSlug: 'calendar-app', ...deps(manifestJson()) });
    expect(keys).toEqual([]);
  });

  it('returns [] when no seed dir resolves / the seed is disabled', async () => {
    expect(await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps(manifestJson(), null) })).toEqual([]);
    expect(
      await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps(manifestJson(), '/seed', true) }),
    ).toEqual([]);
  });

  it('returns [] when the manifest is unreadable or invalid (fail-soft, never throws)', async () => {
    expect(
      await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps(new Error('ENOENT')) }),
    ).toEqual([]);
    expect(await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps('not json') })).toEqual([]);
    expect(
      await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps('{"seedFormatVersion":99}') }),
    ).toEqual([]);
  });

  it('returns [] when the manifest has no corestore entry', async () => {
    const raw = manifestJson({
      stores: [{ kind: 'git', hash: 'h', sizeBytes: 1, source: { type: 'resource', path: 'g' } }],
    });
    expect(await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps(raw) })).toEqual([]);
  });

  it('drops malformed key entries individually, keeping well-formed ones', async () => {
    const raw = manifestJson({
      stores: [
        {
          kind: 'corestore',
          hash: 'h',
          sizeBytes: 1,
          source: { type: 'resource', path: 'c' },
          meta: { coreKeys: [KEY_A, 'zz', 42, 'abc', null] },
        },
      ],
    });
    expect(await resolveSeedLogKeys({ hiveHomeSlug: 'papercusp', ...deps(raw) })).toEqual([KEY_A]);
  });
});
