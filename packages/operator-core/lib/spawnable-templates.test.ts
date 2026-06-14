import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control the fs walk; keep the rest of node:fs real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    promises: { ...actual.promises, readdir: vi.fn(), readFile: vi.fn() },
  };
});

import { existsSync, promises as fs } from 'node:fs';
import { getSpawnableTemplates } from './spawnable-templates';

const CACHE_KEY = Symbol.for('papercusp.spawnableCache');
function resetCache(): void {
  const c = (globalThis as Record<symbol, { value: unknown; expires: number; inflight: unknown } | undefined>)[CACHE_KEY];
  if (c) {
    c.value = null;
    c.expires = 0;
    c.inflight = null;
  }
}

const manifest = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, version: '1.0.0', spawnable: { kind: 'x' }, ...extra });

const catalogFetch = (templates: unknown[]) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ templates }) }));

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
  process.env.PAPERCUSP_HARNESSES_DIR = '/fake/harnesses';
  vi.stubGlobal('fetch', catalogFetch([]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCache();
  delete process.env.PAPERCUSP_HARNESSES_DIR;
});

describe('getSpawnableTemplates — merge local-installed + marketplace catalog', () => {
  it('includes locally-installed templates that declare a spawnable manifest', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['tmpl-a'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(manifest('A') as never);
    const { spawnable } = await getSpawnableTemplates();
    expect(spawnable).toHaveLength(1);
    expect(spawnable[0]).toMatchObject({ name: 'A', source: 'local' });
  });

  it('dedups by name with local winning over a same-named catalog entry', async () => {
    vi.stubGlobal('fetch', catalogFetch([{ name: 'A', version: '9.9.9', spawnable: { kind: 'catalog' } }]));
    vi.mocked(fs.readdir).mockResolvedValue(['tmpl-a'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(manifest('A', { version: '1.0.0' }) as never);
    const { spawnable } = await getSpawnableTemplates();
    expect(spawnable).toHaveLength(1);
    expect(spawnable[0]).toMatchObject({ name: 'A', source: 'local', version: '1.0.0' });
  });

  it('omits manifests that have no spawnable object', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['plain'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ name: 'plain', version: '1.0.0' }) as never);
    const { spawnable } = await getSpawnableTemplates();
    expect(spawnable).toHaveLength(0);
  });

  it('falls through to local-only when the catalog fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('no catalog');
    }));
    vi.mocked(fs.readdir).mockResolvedValue(['tmpl-a'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(manifest('A') as never);
    const { spawnable } = await getSpawnableTemplates();
    expect(spawnable.map((s: { name: string }) => s.name)).toEqual(['A']);
  });

  it('serves a cached value within the TTL without re-reading the fs', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['tmpl-a'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(manifest('A') as never);
    const first = await getSpawnableTemplates();
    const readsAfterFirst = vi.mocked(fs.readdir).mock.calls.length;
    const second = await getSpawnableTemplates();
    expect(second).toBe(first); // same cached object reference
    expect(vi.mocked(fs.readdir).mock.calls.length).toBe(readsAfterFirst); // no extra fs walk
  });
});
