/**
 * Falsifiability tests for scripts/check-tracked-node-modules.mjs (WI-39630).
 *
 * The guard exists because SEVENTEEN submodules simultaneously tracked ~6,500 paths
 * under node_modules while every one of them ALSO had `node_modules/` in .gitignore —
 * a contradiction git resolves as "tracked wins", which silently killed git-sync's
 * commit leg for those repos (16 consecutive failing ticks on dock-workbench).
 *
 * A guard that has only ever been run against a clean tree is not a verified guard.
 * These tests pin the property that matters: the predicate FLAGS a newly-tracked
 * node_modules path, and does not merely return empty for everything.
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs guard script, no type declarations by design (as with sibling guards)
import { ALLOWLIST, findOffenders } from '../../../scripts/check-tracked-node-modules.mjs';

type Offender = { repo: string; paths: string[] };

/** A lister backed by a plain map, so no real repo is needed. */
const listerFor =
  (byRepo: Record<string, string[]>) =>
  (repo: string): string[] =>
    byRepo[repo] ?? [];

describe('check-tracked-node-modules findOffenders', () => {
  it('CALIBRATION: flags a repo that tracks a node_modules path', () => {
    const offenders: Offender[] = findOffenders({
      repos: ['.', 'libs/generic/dock-workbench'],
      listTracked: listerFor({
        'libs/generic/dock-workbench': ['node_modules/.bin/vitest'],
      }),
      allowlist: new Set<string>(),
    });

    expect(offenders).toHaveLength(1);
    expect(offenders[0].repo).toBe('libs/generic/dock-workbench');
    expect(offenders[0].paths).toEqual(['node_modules/.bin/vitest']);
  });

  it('passes a tree where no repo tracks node_modules', () => {
    const offenders: Offender[] = findOffenders({
      repos: ['.', 'libs/test-config', 'libs/generic/sse'],
      listTracked: listerFor({}),
      allowlist: new Set<string>(),
    });

    expect(offenders).toEqual([]);
  });

  it('reports EVERY offending repo, not just the first — the real incident was 17 at once', () => {
    const repos = Array.from({ length: 17 }, (_, i) => `libs/generic/pkg-${i}`);
    const byRepo = Object.fromEntries(
      repos.map((r) => [r, ['node_modules/chai/package.json']]),
    );

    const offenders: Offender[] = findOffenders({
      repos,
      listTracked: listerFor(byRepo),
      allowlist: new Set<string>(),
    });

    expect(offenders).toHaveLength(17);
  });

  it('counts every tracked path so the report cannot understate the blast radius', () => {
    const paths = Array.from({ length: 1660 }, (_, i) => `node_modules/pkg/file-${i}.js`);

    const offenders: Offender[] = findOffenders({
      repos: ['libs/generic/dock-workbench'],
      listTracked: listerFor({ 'libs/generic/dock-workbench': paths }),
      allowlist: new Set<string>(),
    });

    expect(offenders[0].paths).toHaveLength(1660);
  });

  it('honors the allowlist', () => {
    const offenders: Offender[] = findOffenders({
      repos: ['libs/generic/vendored'],
      listTracked: listerFor({ 'libs/generic/vendored': ['node_modules/x/index.js'] }),
      allowlist: new Set(['libs/generic/vendored']),
    });

    expect(offenders).toEqual([]);
  });

  it('ships with an EMPTY allowlist — an entry re-arms the sync outage for that repo', () => {
    expect([...(ALLOWLIST as Set<string>)]).toEqual([]);
  });
});
