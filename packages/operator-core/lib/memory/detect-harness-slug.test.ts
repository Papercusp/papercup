import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectHarnessSlug,
  detectHarnessSlugSync,
  _testing,
} from './detect-harness-slug';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-harness-slug-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkDir(...parts: string[]): string {
  const p = path.join(tmpRoot, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function mkFile(rel: string, content: string): string {
  const p = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('detectHarnessSlugSync — env var override', () => {
  it('returns env var slug when set', () => {
    const cwd = mkDir('some/project');
    const r = detectHarnessSlugSync({
      cwd,
      env: { PAPERCUSP_HARNESS_SLUG: 'overridden-slug' },
    });
    expect(r).toEqual({ slug: 'overridden-slug', source: 'env' });
  });

  it('ignores invalid env slug', () => {
    const cwd = mkDir('some/project');
    const r = detectHarnessSlugSync({
      cwd,
      env: { PAPERCUSP_HARNESS_SLUG: 'bad slug with spaces' },
    });
    expect(r).toEqual({ slug: null, source: null });
  });

  it('ignores empty env slug', () => {
    const cwd = mkDir('some/project');
    const r = detectHarnessSlugSync({ cwd, env: { PAPERCUSP_HARNESS_SLUG: '' } });
    expect(r).toEqual({ slug: null, source: null });
  });
});

describe('detectHarnessSlugSync — marker file', () => {
  it('reads slug from .papercusp/slug at cwd', () => {
    const cwd = mkDir('proj');
    mkFile('proj/.papercusp/slug', 'sheets\n');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: 'sheets', source: 'marker-file' });
  });

  it('reads slug from parent .papercusp/slug (walks up)', () => {
    const deep = mkDir('proj/sub/sub/sub');
    mkFile('proj/.papercusp/slug', 'forms');
    const r = detectHarnessSlugSync({ cwd: deep, env: {} });
    expect(r).toEqual({ slug: 'forms', source: 'marker-file' });
  });

  it('skips invalid slug in marker file', () => {
    const cwd = mkDir('proj');
    mkFile('proj/.papercusp/slug', 'INVALID UPPER');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r.slug).toBe(null);
  });

  it('marker file takes precedence over papercup meta', () => {
    // Construct a dir that looks like papercup AND has .papercusp/slug
    const cwd = mkDir('papercup-root');
    mkFile('papercup-root/package.json', JSON.stringify({ name: 'papercup' }));
    mkDir('papercup-root/libs/papercusp');
    mkFile('papercup-root/.papercusp/slug', 'my-harness');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: 'my-harness', source: 'marker-file' });
  });
});

describe('detectHarnessSlugSync — papercup meta detection', () => {
  it('detects papercup repo via package.json + libs/papercusp (legacy default when pointer unset)', () => {
    const cwd = mkDir('papercup-root/some/sub');
    mkFile('papercup-root/package.json', JSON.stringify({ name: 'papercup' }));
    mkDir('papercup-root/libs/papercusp');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: 'papercup', source: 'meta-papercup' });
  });

  it('detects the real scoped monorepo name (@papercupai/papercup-monorepo)', () => {
    // The live repo's package.json name — the old `name === 'papercup'`
    // check rejected this, leaving meta-detection dead. Generalized match
    // strips the npm scope and accepts papercup[-monorepo].
    const cwd = mkDir('mono-root/apps/x');
    mkFile('mono-root/package.json', JSON.stringify({ name: '@papercupai/papercup-monorepo' }));
    mkDir('mono-root/libs/papercusp');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: 'papercup', source: 'meta-papercup' });
  });

  it('tolerates the papercup→papercusp rename (papercusp-monorepo)', () => {
    const cwd = mkDir('cusp-root');
    mkFile('cusp-root/package.json', JSON.stringify({ name: 'papercusp-monorepo' }));
    mkDir('cusp-root/libs/papercusp');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: 'papercup', source: 'meta-papercup' });
  });

  it('returns the configured home pointer (PAPERCUSP_HIVE_HOME_SLUG), not a baked literal', () => {
    const cwd = mkDir('papercup-root');
    mkFile('papercup-root/package.json', JSON.stringify({ name: 'papercup' }));
    mkDir('papercup-root/libs/papercusp');
    const r = detectHarnessSlugSync({ cwd, env: { PAPERCUSP_HIVE_HOME_SLUG: 'papercusp' } });
    expect(r).toEqual({ slug: 'papercusp', source: 'meta-papercup' });
  });

  it('does NOT detect when package.json name mismatches', () => {
    const cwd = mkDir('other-root');
    mkFile('other-root/package.json', JSON.stringify({ name: 'not-papercup' }));
    mkDir('other-root/libs/papercusp');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: null, source: null });
  });

  it('does NOT detect when libs/papercusp missing', () => {
    const cwd = mkDir('lonely-pkg');
    mkFile('lonely-pkg/package.json', JSON.stringify({ name: 'papercup' }));
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: null, source: null });
  });
});

describe('detectHarnessSlugSync — null path', () => {
  it('returns null when nothing matches', () => {
    const cwd = mkDir('boring/project');
    const r = detectHarnessSlugSync({ cwd, env: {} });
    expect(r).toEqual({ slug: null, source: null });
  });

  it('returns null when env var is invalid AND no marker present', () => {
    const cwd = mkDir('boring/project');
    const r = detectHarnessSlugSync({
      cwd,
      env: { PAPERCUSP_HARNESS_SLUG: 'WITH SPACES' },
    });
    expect(r).toEqual({ slug: null, source: null });
  });
});

describe('detectHarnessSlug — async with registry fallback', () => {
  it('uses sync result when found', async () => {
    const cwd = mkDir('proj');
    mkFile('proj/.papercusp/slug', 'sheets');
    const r = await detectHarnessSlug({
      cwd,
      env: {},
      registryLookup: async () => 'should-not-be-used',
    });
    expect(r).toEqual({ slug: 'sheets', source: 'marker-file' });
  });

  it('falls back to registry when sync returns null', async () => {
    const cwd = mkDir('orphan');
    const r = await detectHarnessSlug({
      cwd,
      env: {},
      registryLookup: async (c) => (c === cwd ? 'registry-slug' : null),
    });
    expect(r).toEqual({ slug: 'registry-slug', source: 'registry' });
  });

  it('returns null when registry returns invalid slug', async () => {
    const cwd = mkDir('orphan');
    const r = await detectHarnessSlug({
      cwd,
      env: {},
      registryLookup: async () => 'BAD SLUG',
    });
    expect(r).toEqual({ slug: null, source: null });
  });

  it('returns null when registry throws', async () => {
    const cwd = mkDir('orphan');
    const r = await detectHarnessSlug({
      cwd,
      env: {},
      registryLookup: async () => {
        throw new Error('PG down');
      },
    });
    expect(r).toEqual({ slug: null, source: null });
  });

  it('returns null when no registryLookup + no sync match', async () => {
    const cwd = mkDir('orphan');
    const r = await detectHarnessSlug({ cwd, env: {} });
    expect(r).toEqual({ slug: null, source: null });
  });
});

describe('detect-harness-slug internals', () => {
  it('validSlug accepts kebab + alnum, rejects others', () => {
    const { validSlug } = _testing;
    expect(validSlug('sheets')).toBe(true);
    expect(validSlug('my-harness-001')).toBe(true);
    expect(validSlug('a')).toBe(true);
    expect(validSlug('UPPER')).toBe(false);
    expect(validSlug('has space')).toBe(false);
    expect(validSlug('has/slash')).toBe(false);
    expect(validSlug('-leading-dash')).toBe(false);
    expect(validSlug('')).toBe(false);
    expect(validSlug(null)).toBe(false);
    expect(validSlug(undefined)).toBe(false);
  });

  it('walkUp stops at filesystem root', () => {
    const { walkUp } = _testing;
    const dirs = Array.from(walkUp('/some/deep/path'));
    // Should include /some/deep/path, /some/deep, /some, /
    expect(dirs[0]).toBe('/some/deep/path');
    expect(dirs[dirs.length - 1]).toBe('/');
  });
});
