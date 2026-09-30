/**
 * WI-10004151 — install-equivalence of an exact ref's dependency inputs vs the live tree's.
 * dependency-generation.sh builds an exact-ref generation from the live trees ONLY when this
 * helper proves the two locks install the same packages modulo live-only workspace links, so
 * every non-link difference must be refused (a false "equivalent" publishes a generation
 * under a key its contents do not match).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const HELPER = join(__dirname, '../../bin/release/dependency-lock-equivalence.mjs');

type Entry = Record<string, unknown>;
interface CompareResult { drops: string[]; reasons: string[] }
interface EquivalenceModule {
  compareLockfile(lockRel: string, refLock: unknown, liveLock: unknown): CompareResult;
  compareDependencyInputs(input: {
    refManifest: Map<string, string>;
    liveManifest: Map<string, string>;
    readRef(rel: string): string | undefined;
    readLive(rel: string): string | undefined;
  }): CompareResult & { equivalent: boolean };
  parseInputManifest(text: string): Map<string, string>;
}
// The helper is a standalone node:* ESM script (no declaration file); load it the way the
// shell does not need to — as a module — to unit-test its decision functions.
let mod: EquivalenceModule;
beforeAll(async () => {
  mod = (await import(pathToFileURL(HELPER).href)) as EquivalenceModule;
});
const compareLockfile: EquivalenceModule['compareLockfile'] = (...args) => mod.compareLockfile(...args);
const compareDependencyInputs: EquivalenceModule['compareDependencyInputs'] = (input) => mod.compareDependencyInputs(input);
const parseInputManifest: EquivalenceModule['parseInputManifest'] = (text) => mod.parseInputManifest(text);
const lock = (packages: Record<string, Entry>) => ({ name: 'r', lockfileVersion: 3, packages: { '': { name: 'r' }, ...packages } });
const PKG: Record<string, Entry> = {
  'node_modules/pkg': { version: '1.0.0', resolved: 'https://r.invalid/pkg-1.0.0.tgz', integrity: 'sha512-a' },
};

describe('compareLockfile', () => {
  it('is equivalent when only dev/optional/peer flags and workspace declarations differ', () => {
    const ref = lock({ ...PKG, 'packages/x': { name: 'x', version: '1.0.0' } });
    const live = lock({
      'node_modules/pkg': { ...PKG['node_modules/pkg'], dev: true, devOptional: true, peer: true },
      'packages/x': { name: 'x', version: '2.0.0', dependencies: { y: '1' } },
    });
    expect(compareLockfile('package-lock.json', ref, live)).toEqual({ drops: [], reasons: [] });
  });

  it('names a live-only workspace link as a drop, relative to the lockfile directory', () => {
    const live = lock({ ...PKG, 'node_modules/@p/extra': { resolved: 'packages/extra', link: true } });
    expect(compareLockfile('libs/sub/package-lock.json', lock(PKG), live)).toEqual({
      drops: ['libs/sub/node_modules/@p/extra'],
      reasons: [],
    });
  });

  it.each([
    ['a version change', { 'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' } }, 'version'],
    ['an integrity change', { 'node_modules/pkg': { ...PKG['node_modules/pkg'], integrity: 'sha512-b' } }, 'integrity'],
    ['a resolved change', { 'node_modules/pkg': { ...PKG['node_modules/pkg'], resolved: 'https://r.invalid/x.tgz' } }, 'resolved'],
    ['a live-only real package', { ...PKG, 'node_modules/other': { version: '1.0.0' } }, 'absent from the ref'],
    ['a ref-only package', {}, 'needs an install'],
    ['a link retargeted', { ...PKG, 'node_modules/w': { resolved: 'packages/b', link: true } }, 'resolved'],
  ])('refuses %s', (_label, livePackages, reason) => {
    const refPackages = _label === 'a link retargeted'
      ? { ...PKG, 'node_modules/w': { resolved: 'packages/a', link: true } }
      : PKG;
    const result = compareLockfile('package-lock.json', lock(refPackages), lock(livePackages as Record<string, Entry>));
    expect(result.reasons.join('\n')).toContain(reason);
  });

  it('refuses a v1 lockfile without a packages map rather than assuming equivalence', () => {
    const result = compareLockfile('package-lock.json', { lockfileVersion: 1, dependencies: {} }, lock(PKG));
    expect(result.reasons[0]).toContain('no packages map');
  });
});

describe('compareDependencyInputs', () => {
  const run = (ref: Record<string, string>, live: Record<string, string>, refFiles: Record<string, string> = {}, liveFiles: Record<string, string> = {}) =>
    compareDependencyInputs({
      refManifest: new Map(Object.entries(ref)),
      liveManifest: new Map(Object.entries(live)),
      readRef: (rel: string) => refFiles[rel],
      readLive: (rel: string) => liveFiles[rel],
    });

  it('skips byte-identical inputs without parsing them', () => {
    expect(run({ 'package-lock.json': 'd1' }, { 'package-lock.json': 'd1' })).toEqual({ equivalent: true, drops: [], reasons: [] });
  });

  it('refuses a differing patch and an input present on one side only', () => {
    const result = run(
      { 'patches/a.patch': 'p1', 'sub/package-lock.json': 'l1' },
      { 'patches/a.patch': 'p2', 'other/package-lock.json': 'l2' },
    );
    expect(result.equivalent).toBe(false);
    expect(result.reasons).toEqual([
      'other/package-lock.json: dependency input exists only in the live tree',
      'patches/a.patch: patch differs between the ref and the live tree',
      'sub/package-lock.json: dependency input exists only at the ref',
    ]);
  });

  it('parses a differing lockfile and returns its drops', () => {
    const result = run(
      { 'package-lock.json': 'r' },
      { 'package-lock.json': 'l' },
      { 'package-lock.json': JSON.stringify(lock(PKG)) },
      { 'package-lock.json': JSON.stringify(lock({ ...PKG, 'node_modules/@p/w': { resolved: 'packages/w', link: true } })) },
    );
    expect(result).toEqual({ equivalent: true, drops: ['node_modules/@p/w'], reasons: [] });
  });
});

describe('dependency-lock-equivalence CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'dep-lock-eq-'));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const cli = (refLock: object, liveLock: object) => {
    const ref = tree({ 'package-lock.json': JSON.stringify(refLock), 'm': 'package-lock.json\tref\n' });
    const live = tree({ 'package-lock.json': JSON.stringify(liveLock), 'm': 'package-lock.json\tlive\n' });
    return spawnSync(process.execPath, [
      HELPER, '--ref-root', ref, '--ref-manifest', join(ref, 'm'), '--live-root', live, '--live-manifest', join(live, 'm'),
    ], { encoding: 'utf8' });
  };

  it('prints DROP_LINK lines and exits 0 when equivalent', () => {
    const result = cli(lock(PKG), lock({ ...PKG, 'node_modules/@p/w': { resolved: 'packages/w', link: true } }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('DROP_LINK\tnode_modules/@p/w\n');
  });

  it('prints NOT_EQUIVALENT lines and exits 3 otherwise', () => {
    const result = cli(lock(PKG), lock({ 'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '9.0.0' } }));
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('NOT_EQUIVALENT\tnode_modules/pkg: version "1.0.0" (ref) vs "9.0.0" (live)');
  });

  it('exits 2 on misuse', () => {
    const result = spawnSync(process.execPath, [HELPER, '--ref-root', '/nonexistent'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });

  it('parses manifests strictly', () => {
    expect(() => parseInputManifest('no-tab-line\n')).toThrow(/malformed/);
  });
});
