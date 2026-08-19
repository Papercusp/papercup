/**
 * check-peer-dep-conflicts.test.ts — pins scripts/check-peer-dep-conflicts.mjs
 * (EI-20863237237162828).
 *
 * ## What broke, and why nothing caught it
 *
 * `libs/papercusp-shared` declared `peerDependencies: { "dockview": "^5" }` while the
 * root tree installs dockview 6.6.1. npm resolves peers TREE-WIDE, so this made
 * `npm install` — and therefore `npm run install:safe`, the ONE sanctioned install path
 * in this repo — fail with ERESOLVE for EVERY agent on EVERY package. While it was red
 * there was no sanctioned way to repair dependencies at all.
 *
 * The mirror guard already existed (`check-workspace-deps-complete.mjs`: imported but
 * NOT declared). Nothing covered the opposite direction — DECLARED but conflicting with
 * what the tree provides.
 *
 * ## Falsifiability without touching the shared tree
 *
 * CLAUDE.md's mutation-probe rule forbids proving a guard falsifiable by mutating the
 * shared checkout: git-sync sweeps the whole tree on a schedule and can COMMIT the mutant
 * even when nothing goes wrong. So every failing case here is a FIXTURE TREE under
 * `mkdtemp` (tier 2 — mutate a copy outside the tree, point the subject at it via
 * `PEER_DEP_CONFLICTS_ROOT` / the `scan(root)` parameter). Zero sweep race, no trap
 * needed, and the deliberately-wrong inputs live here permanently as controls rather
 * than existing for the duration of one probe.
 *
 * ## The calibration case that keeps the controls honest
 *
 * A guard that flagged EVERYTHING would pass every "does it fire?" assertion above. So
 * the suite also asserts the REAL repo currently measures clean and that BASELINE is
 * empty — if the guard starts flagging the live tree, these fail rather than silently
 * agreeing with the mutant cases.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  scan,
  satisfies,
  parseRange,
  parseVersion,
  UnsupportedRange,
  BASELINE,
  EXIT_OK,
  EXIT_CONFLICTS,
  EXIT_NOT_CHECKED,
} from '../../../../scripts/check-peer-dep-conflicts.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const GUARD = join(REPO_ROOT, 'scripts/check-peer-dep-conflicts.mjs');

/** Build a throwaway workspace tree outside the repo. Returns its root. */
function fixture(opts: {
  peer?: Record<string, string>;
  installed?: Record<string, string>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'peerguard-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['libs/*'] }));
  mkdirSync(join(root, 'libs/shared'), { recursive: true });
  writeFileSync(
    join(root, 'libs/shared/package.json'),
    JSON.stringify({ name: '@x/shared', peerDependencies: opts.peer ?? {} }),
  );
  for (const [name, version] of Object.entries(opts.installed ?? {})) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  return root;
}

function runGuard(root: string): number {
  const r = spawnSync(process.execPath, [GUARD], {
    env: { ...process.env, PEER_DEP_CONFLICTS_ROOT: root },
    encoding: 'utf8',
  });
  return r.status ?? -1;
}

describe('check-peer-dep-conflicts — the regression it exists for', () => {
  it('FIRES on the exact incident shape: peer "^5" against an installed 6.6.1', () => {
    const root = fixture({ peer: { dockview: '^5' }, installed: { dockview: '6.6.1' } });
    try {
      const result = scan(root);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        workspace: '@x/shared',
        dep: 'dockview',
        range: '^5',
        installed: '6.6.1',
      });
      expect(runGuard(root)).toBe(EXIT_CONFLICTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PASSES once the range is widened to "^5 || ^6" — the guard is not just always-red', () => {
    const root = fixture({ peer: { dockview: '^5 || ^6' }, installed: { dockview: '6.6.1' } });
    try {
      expect(scan(root).conflicts).toHaveLength(0);
      expect(runGuard(root)).toBe(EXIT_OK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PASSES when the peer is dropped entirely — the fix actually applied to the repo', () => {
    const root = fixture({ peer: {}, installed: { dockview: '6.6.1' } });
    try {
      expect(scan(root).conflicts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-peer-dep-conflicts — "could not judge" never renders as clean', () => {
  it('reports NOT_CHECKED (2), not OK, for a range form it does not implement', () => {
    const root = fixture({ peer: { dockview: '~6.6.0' }, installed: { dockview: '6.6.1' } });
    try {
      const result = scan(root);
      expect(result.unsupported).toHaveLength(1);
      expect(result.conflicts).toHaveLength(0);
      // The whole point: an unjudged range must NOT come back as a passing check.
      expect(runGuard(root)).toBe(EXIT_NOT_CHECKED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports NOT_CHECKED (2) when no workspaces resolve at all', () => {
    expect(runGuard(join(tmpdir(), 'peerguard-does-not-exist-at-all'))).toBe(EXIT_NOT_CHECKED);
  });

  it('reports NOT_CHECKED (2) — never OK — when nothing is installed to judge against', () => {
    const root = fixture({ peer: { dockview: '^5' }, installed: {} });
    try {
      const result = scan(root);
      expect(result.checked).toBe(0);
      expect(result.unprovided).toBe(1);
      // An uninstalled peer is a DIFFERENT class (npm's unmet-peer handling); flagging it
      // here would be a false positive. But an empty measurement must not read as clean.
      expect(result.conflicts).toHaveLength(0);
      expect(runGuard(root)).toBe(EXIT_NOT_CHECKED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not judge local workspace packages, which are linked rather than resolved', () => {
    const root = fixture({
      peer: { '@papercusp/flags': '^99' },
      installed: { '@papercusp/flags': '1.0.0' },
    });
    try {
      const result = scan(root);
      expect(result.conflicts).toHaveLength(0);
      expect(result.checked).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-peer-dep-conflicts — range grammar', () => {
  // Every range FORM measured in the repo's real peer declarations (2026-08-19), each
  // with a satisfying and a non-satisfying version. Extend this table whenever
  // parseRange() learns a new form.
  const cases: Array<[version: string, range: string, satisfied: boolean]> = [
    ['6.6.1', '^5', false],
    ['6.6.1', '^6.2.2', true],
    ['19.1.0', '^18 || ^19', true],
    ['17.0.2', '^18 || ^19', false],
    ['19.0.0', '>=19.0.0', true],
    ['18.3.1', '>=19.0.0', false],
    ['5.9.3', '^5 || ^6', true],
    ['7.0.0', '^5 || ^6', false],
    ['4.0.0', '>=4', true],
    ['3.9.9', '>=4', false],
    ['11.2.0', '^11.0.0', true],
    ['12.0.0', '^11.0.0', false],
    ['3.11.2', '^3.11.2', true],
    ['3.11.1', '^3.11.2', false],
    ['16.1.0', '^15 || ^16', true],
    ['1.3.0', '^1.2.8', true],
    ['2.0.0', '^1.2.8', false],
    ['4.5.0', '^4', true],
    ['5.0.0', '^4', false],
    ['18.0.0', '>=18', true],
    ['5.2.0', '>=4 <6', true],
    ['6.0.0', '>=4 <6', false],
    ['3.0.0', '>=4 <6', false],
    ['3.0.0', '>=3.0.0', true],
    ['4.1.0', '^4.0.0', true],
    ['99.0.0', '*', true],
    // 0.x caret is narrower than >=1 caret — a minor bump is a break.
    ['0.5.9', '^0.5.0', true],
    ['0.6.0', '^0.5.0', false],
  ];

  it.each(cases)('satisfies(%s, %s) === %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('THROWS rather than guessing on range forms it does not implement', () => {
    for (const bad of ['~1.2.3', '1.x', '1.0.0 - 2.0.0', 'latest', 'workspace:*']) {
      expect(() => parseRange(bad), bad).toThrow(UnsupportedRange);
    }
  });

  it('THROWS rather than guessing on a version it cannot parse (prerelease, tag)', () => {
    expect(() => satisfies('6.0.0-beta.1', '^6')).toThrow(UnsupportedRange);
    expect(() => satisfies('next', '^6')).toThrow(UnsupportedRange);
    expect(parseVersion('6.0.0-beta.1')).toBeNull();
  });
});

describe('check-peer-dep-conflicts — calibration against the real repo', () => {
  // Without this, every assertion above would still pass for a guard that flags
  // everything. This is what makes the mutant cases meaningful.
  it('measures the live tree CLEAN, and keeps BASELINE empty', () => {
    const result = scan(REPO_ROOT);
    expect(result.workspaces).toBeGreaterThan(50);
    expect(result.checked).toBeGreaterThan(20);
    expect(result.unsupported).toEqual([]);
    expect(result.conflicts).toEqual([]);
    // Authored against an already-clean tree: there is no historical debt to grandfather,
    // so any entry here would be a regression being silenced rather than fixed.
    expect(BASELINE).toEqual([]);
  });

  it('declares the npm script in the workspace the guard registry names', () => {
    // THE SILENT NO-OP THIS PINS: affected-tests.mjs attaches a repo-wide guard with
    //   `if (!ws?.scripts?.[guard.script]) continue;`
    // so a registry entry whose workspace does NOT declare the script is skipped without
    // any error — the guard reads as wired while running never. The registry entry names
    // @papercusp/operator-core, so that package.json is the load-bearing declaration;
    // root's exists only for hand-runs.
    const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
    const wsPkg = readJson(join(REPO_ROOT, 'packages/operator-core/package.json'));
    expect(wsPkg.scripts['lint:peer-dep-conflicts']).toBe('node ../../scripts/check-peer-dep-conflicts.mjs');

    const rootPkg = readJson(join(REPO_ROOT, 'package.json'));
    expect(rootPkg.scripts['lint:peer-dep-conflicts']).toBe('node scripts/check-peer-dep-conflicts.mjs');

    // And the registry actually names it, with the not-checked escape a gate checkout needs.
    const registry = readFileSync(join(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
    expect(registry).toContain('script: "lint:peer-dep-conflicts"');
  });

  it('resolves the repo root from the script location, not the caller cwd', () => {
    // operator-core invokes it as `node ../../scripts/...` from its own directory, so a
    // cwd-derived root would silently scan the wrong tree (and report a clean 2).
    const fromWorkspaceDir = spawnSync(process.execPath, [GUARD], {
      cwd: join(REPO_ROOT, 'packages/operator-core'),
      env: { ...process.env, PEER_DEP_CONFLICTS_ROOT: '' },
      encoding: 'utf8',
    });
    expect(fromWorkspaceDir.status).toBe(EXIT_OK);
    expect(fromWorkspaceDir.stdout).toContain('OK');
  });
});
