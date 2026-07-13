import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lockDomainForProjectDir,
  lockCoordinationDomain,
  __resetLockCoordinationDomain,
} from './coordination-domain';

/** Scaffold a VALID fake git dir — findRepoRoot requires a gitlink file or a git
 *  dir WITH HEAD (valid-git-entry.ts); a bare empty `.git` no longer counts. */
const mkFakeGitDir = (root: string) => {
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
};

const SAVED = process.env.PAPERCUSP_LOCK_DOMAIN;
beforeEach(() => {
  delete process.env.PAPERCUSP_LOCK_DOMAIN;
  __resetLockCoordinationDomain();
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.PAPERCUSP_LOCK_DOMAIN;
  else process.env.PAPERCUSP_LOCK_DOMAIN = SAVED;
  __resetLockCoordinationDomain();
});

describe('lockDomainForProjectDir', () => {
  it('honors the PAPERCUSP_LOCK_DOMAIN override (trimmed)', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '  /custom/domain  ';
    expect(lockDomainForProjectDir('/anywhere')).toBe('/custom/domain');
  });

  it('resolves to the realpath of the nearest .git ancestor (so two workspaces over one checkout serialize)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-'));
    mkFakeGitDir(root);
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(lockDomainForProjectDir(sub)).toBe(realpathSync(root));
  });

  it('falls back to the start dir when no .git ancestor exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norepo-'));
    expect(lockDomainForProjectDir(dir)).toBe(realpathSync(dir));
  });

  it('ignores a stray EMPTY `.git` dir ancestor — never a domain that collapses unrelated locks (the 2026-07-13 /tmp/.git incident)', () => {
    // An accidental `mkdir .git` in a shared ancestor (it happened at /tmp) must
    // not become the lock domain for every path beneath it — a HEAD-less `.git`
    // dir is not a repo. The domain falls through to the start dir instead.
    const root = mkdtempSync(join(tmpdir(), 'lockdom-stray-'));
    mkdirSync(join(root, '.git')); // EMPTY — no HEAD, not a gitlink
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(lockDomainForProjectDir(sub)).toBe(realpathSync(sub));
  });

  it('ignores an empty / whitespace-only PAPERCUSP_LOCK_DOMAIN (never an empty domain that collapses all locks)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-empty-'));
    mkFakeGitDir(root);
    process.env.PAPERCUSP_LOCK_DOMAIN = '   ';
    expect(lockDomainForProjectDir(root)).toBe(realpathSync(root)); // falls through, not '' nor the blank override
  });

  it('resolves a SYMLINKED path to the same domain as the real path (two paths to one checkout serialize)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-real-'));
    mkFakeGitDir(root);
    const link = `${root}-link`;
    symlinkSync(root, link); // a second path that points at the same checkout
    // Editing via the real path and via the symlink must key on the SAME (realpath) domain — else the
    // two would split into independent namespaces and clobber (the dbos-system-completion D-015 bug).
    expect(lockDomainForProjectDir(link)).toBe(realpathSync(root));
    expect(lockDomainForProjectDir(link)).toBe(lockDomainForProjectDir(root));
  });

  it('keys on the NEAREST .git ancestor when repos are nested (a submodule serializes on its own root)', () => {
    const outer = mkdtempSync(join(tmpdir(), 'lockdom-outer-'));
    mkFakeGitDir(outer);
    const inner = join(outer, 'sub');
    mkdirSync(inner);
    mkFakeGitDir(inner); // a nested repo (e.g. a submodule) with its OWN .git
    const deep = join(inner, 'x', 'y');
    mkdirSync(deep, { recursive: true });
    expect(lockDomainForProjectDir(deep)).toBe(realpathSync(inner)); // the inner root wins, not the outer
  });
});

describe('lockCoordinationDomain', () => {
  it('honors the override and caches it until reset', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '/d1';
    expect(lockCoordinationDomain()).toBe('/d1');
    process.env.PAPERCUSP_LOCK_DOMAIN = '/d2';
    expect(lockCoordinationDomain()).toBe('/d1'); // cached — env change not re-read
    __resetLockCoordinationDomain();
    expect(lockCoordinationDomain()).toBe('/d2'); // re-read after reset
  });
});
