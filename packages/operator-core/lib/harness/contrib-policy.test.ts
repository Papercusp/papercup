/**
 * contrib-policy.test.ts — P-CONTRIB contribution rules (EN-4). Teeth-verified:
 *  - editable-path allowlist: an in-bounds change is allowed, an out-of-bounds one
 *    is REJECTED (the precise S0 the brief names);
 *  - require-review / restrict-auto-merge / required-status-checks each BLOCK
 *    auto-merge; a bare policy allows it;
 *  - the glob matcher handles `**`, `*`, dir-prefix, and exact patterns.
 */

import { describe, it, expect } from 'vitest';
import { checkContribPolicy, globMatch, matchesAnyGlob, type ContribPolicy } from './contrib-policy';

describe('globMatch', () => {
  it('matches `**` across path segments', () => {
    expect(globMatch('packages/**', 'packages/a/b/c.ts')).toBe(true);
    expect(globMatch('packages/**/*.ts', 'packages/x/y.ts')).toBe(true);
    expect(globMatch('packages/**', 'apps/a.ts')).toBe(false);
  });
  it('matches `*` only within a segment', () => {
    expect(globMatch('*.md', 'README.md')).toBe(true);
    expect(globMatch('*.md', 'docs/README.md')).toBe(false); // `*` does not cross `/`
  });
  it('matches a dir prefix and a trailing-slash dir', () => {
    expect(globMatch('docs/', 'docs/guide.md')).toBe(true);
    expect(globMatch('docs', 'docs/guide.md')).toBe(true);
    expect(globMatch('docs', 'docs')).toBe(true);
    expect(globMatch('doc', 'docs/guide.md')).toBe(false); // partial segment must not match
  });
  it('matches exact files', () => {
    expect(globMatch('LICENSE', 'LICENSE')).toBe(true);
    expect(globMatch('LICENSE', 'LICENSE.md')).toBe(false);
  });
  it('matchesAnyGlob ORs the patterns', () => {
    expect(matchesAnyGlob(['*.md', 'src/**'], 'src/a/b.ts')).toBe(true);
    expect(matchesAnyGlob(['*.md', 'src/**'], 'config.yaml')).toBe(false);
  });
});

describe('checkContribPolicy — editable paths', () => {
  const policy: ContribPolicy = { editablePaths: ['docs/**', '*.md'] };
  it('allows a PR whose changes are all in-bounds', () => {
    const d = checkContribPolicy(policy, { changedFiles: ['docs/a.md', 'README.md'] });
    expect(d.pathsAllowed).toBe(true);
    expect(d.deniedPaths).toEqual([]);
  });
  it('REJECTS a PR that touches an out-of-bounds path (the S0 teeth)', () => {
    const d = checkContribPolicy(policy, {
      changedFiles: ['docs/a.md', 'packages/core/secrets.ts'],
    });
    expect(d.pathsAllowed).toBe(false);
    expect(d.deniedPaths).toEqual(['packages/core/secrets.ts']);
  });
  it('no allowlist ⇒ any path allowed', () => {
    const d = checkContribPolicy({}, { changedFiles: ['anything/at/all.ts'] });
    expect(d.pathsAllowed).toBe(true);
  });
});

describe('checkContribPolicy — auto-merge gate', () => {
  it('require-review blocks auto-merge', () => {
    const d = checkContribPolicy({ requireReview: true }, { changedFiles: [] });
    expect(d.autoMergeAllowed).toBe(false);
    expect(d.autoMergeBlockedBy).toContain('requireReview');
  });
  it('restrict-auto-merge blocks auto-merge', () => {
    const d = checkContribPolicy({ restrictAutoMerge: true }, { changedFiles: [] });
    expect(d.autoMergeAllowed).toBe(false);
    expect(d.autoMergeBlockedBy).toContain('restrictAutoMerge');
  });
  it('required status checks block auto-merge', () => {
    const d = checkContribPolicy({ requiredStatusChecks: ['ci/test'] }, { changedFiles: [] });
    expect(d.autoMergeAllowed).toBe(false);
    expect(d.autoMergeBlockedBy).toContain('requiredStatusChecks');
  });
  it('a bare/empty policy allows auto-merge', () => {
    expect(checkContribPolicy({}, { changedFiles: [] }).autoMergeAllowed).toBe(true);
    expect(checkContribPolicy(null, { changedFiles: [] }).autoMergeAllowed).toBe(true);
  });
});
