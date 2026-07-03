/**
 * scope-repo unit tests — FS-D2 id parsing, the ref-segment round-trip, the
 * foreign-marked-ref contract compatibility (the landed isForeignMarkedRef
 * parser MUST recognize scope tracking refs — D-018 n-note), and path safety.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  formatScopeId,
  isScopeRepoFamilyPath,
  parseScopeId,
  parseScopeRefSegment,
  parseScopeRepoPath,
  scopeForeignRef,
  scopeRefSegment,
  scopeRepoPath,
  type ScopeId,
} from './scope-repo';
import { isForeignMarkedRef, foreignFleetFromRef } from './foreign-merge-admission';
import { hiveGitRoot } from './storage';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 279242982, slug: 'p2p-dist' };

describe('parseScopeId / formatScopeId (FS-D2)', () => {
  it('round-trips the canonical form', () => {
    const id = formatScopeId(SCOPE);
    expect(id).toBe('fleet:279242982/p2p-dist');
    expect(parseScopeId(id)).toEqual(SCOPE);
  });

  it('rejects login-keyed grantors (X9: numeric ids only)', () => {
    expect(parseScopeId('fleet:aviynw/p2p-dist')).toBeNull();
  });

  it.each([
    ['bad kind', 'pool:1/x'],
    ['leading zero uid', 'fleet:0123/x'],
    ['zero uid', 'fleet:0/x'],
    ['missing slug', 'fleet:123/'],
    ['missing slash', 'fleet:123'],
    ['uppercase slug', 'fleet:123/Bad'],
    ['slug traversal', 'fleet:123/..'],
    ['extra segment', 'fleet:123/a/b'],
    ['empty', ''],
  ])('rejects %s', (_name, raw) => {
    expect(parseScopeId(raw)).toBeNull();
  });
});

describe('scopeRefSegment round-trip', () => {
  it('encodes to a single git-ref-safe segment and parses back', () => {
    const seg = scopeRefSegment(SCOPE);
    expect(seg).toBe('fleet-279242982--p2p-dist');
    expect(seg).not.toMatch(/[:/\\ ~^?*[\]]/); // git-ref-hostile chars absent
    expect(parseScopeRefSegment(seg)).toEqual(SCOPE);
  });

  it('parses from the left so slugs containing digits/dashes stay unambiguous', () => {
    const scope: ScopeId = { kind: 'fleet', ownerGithubUserId: 7, slug: 'a-1--b' };
    expect(parseScopeRefSegment(scopeRefSegment(scope))).toEqual(scope);
  });

  it('rejects non-scope segments', () => {
    expect(parseScopeRefSegment('fleet-abc--x')).toBeNull();
    expect(parseScopeRefSegment('p2p-dist')).toBeNull();
  });
});

describe('scopeForeignRef — landed isForeignMarkedRef contract (D-018)', () => {
  it('produces refs the landed foreign-marked parser recognizes', () => {
    const ref = scopeForeignRef(SCOPE, 'result/WI-1700');
    expect(ref).toBe('refs/foreign/fleet-279242982--p2p-dist/result/WI-1700');
    expect(isForeignMarkedRef(ref)).toBe(true);
    expect(foreignFleetFromRef(ref)).toBe(scopeRefSegment(SCOPE));
  });

  it('refuses unsafe ref names', () => {
    expect(() => scopeForeignRef(SCOPE, '../escape')).toThrow(/unsafe/);
    expect(() => scopeForeignRef(SCOPE, '')).toThrow(/unsafe/);
  });
});

describe('scopeRepoPath', () => {
  const OLD_ROOT = process.env.PAPERCUSP_HIVE_GIT_ROOT;
  afterEach(() => {
    if (OLD_ROOT === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    else process.env.PAPERCUSP_HIVE_GIT_ROOT = OLD_ROOT;
  });

  it('nests under the hive-git root (serve backstop coverage)', () => {
    process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-test-root';
    const p = scopeRepoPath('papercusp', SCOPE);
    expect(p).toBe(join(hiveGitRoot(), 'papercusp', 'scopes', 'fleet-279242982', 'p2p-dist.git'));
    expect(p.startsWith(hiveGitRoot())).toBe(true);
  });

  it('rejects a traversal-shaped hive slug', () => {
    expect(() => scopeRepoPath('../etc', SCOPE)).toThrow(/unsafe/);
  });
});

describe('isScopeRepoFamilyPath / parseScopeRepoPath (§5.3 gate encodings)', () => {
  const OLD_ROOT = process.env.PAPERCUSP_HIVE_GIT_ROOT;
  afterEach(() => {
    if (OLD_ROOT === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    else process.env.PAPERCUSP_HIVE_GIT_ROOT = OLD_ROOT;
  });

  it('round-trips scopeRepoPath', () => {
    process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-gate-root';
    const p = scopeRepoPath('my-hive', SCOPE);
    expect(isScopeRepoFamilyPath(p)).toBe(true);
    expect(parseScopeRepoPath(p)).toEqual({ hiveHomeSlug: 'my-hive', scope: SCOPE });
  });

  it('family check is BROADER than the strict parse (malformed inside scopes/ still trips the gate)', () => {
    process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-gate-root';
    const malformed = join(hiveGitRoot(), 'my-hive', 'scopes', 'not-a-fleet-dir', 'x.git');
    expect(isScopeRepoFamilyPath(malformed)).toBe(true);
    expect(parseScopeRepoPath(malformed)).toBeNull();
  });

  it.each([
    ['hive repo itself', () => join(hiveGitRoot(), 'my-hive', 'repo.git')],
    ['outside the root', () => '/somewhere/else/my-hive/scopes/fleet-1/x.git'],
    ['root itself', () => hiveGitRoot()],
    ['scopes as hive name (depth 1)', () => join(hiveGitRoot(), 'scopes')],
  ])('not in the family: %s', (_name, mk) => {
    process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-gate-root';
    expect(isScopeRepoFamilyPath(mk())).toBe(false);
    expect(parseScopeRepoPath(mk())).toBeNull();
  });

  it.each([
    ['login-keyed owner dir', 'my-hive/scopes/fleet-aviynw/x.git'],
    ['zero uid', 'my-hive/scopes/fleet-0/x.git'],
    ['leading-zero uid', 'my-hive/scopes/fleet-0123/x.git'],
    ['missing .git suffix', 'my-hive/scopes/fleet-9/x'],
    ['empty slug', 'my-hive/scopes/fleet-9/.git'],
    ['uppercase slug', 'my-hive/scopes/fleet-9/Bad.git'],
    ['extra depth', 'my-hive/scopes/fleet-9/nested/x.git'],
    ['missing repo file', 'my-hive/scopes/fleet-9'],
  ])('strict parse refuses %s', (_name, rel) => {
    process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-gate-root';
    expect(parseScopeRepoPath(join(hiveGitRoot(), rel))).toBeNull();
  });

  it('escape via .. resolves out of the family', () => {
    process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-gate-root';
    const escapee = join(hiveGitRoot(), 'my-hive', 'scopes', '..', '..', 'other', 'repo.git');
    expect(isScopeRepoFamilyPath(escapee)).toBe(false);
    expect(parseScopeRepoPath(escapee)).toBeNull();
  });
});
