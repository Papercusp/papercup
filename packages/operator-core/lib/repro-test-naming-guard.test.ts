/**
 * Recurrence guard for the `.repro.test.ts` deploy-gate footgun (WI-1091 / WI-1053).
 *
 * A `*.repro.test.ts` reproduces an UNFIXED bug and fails BY DESIGN. When one is
 * named as a plain unit `*.test.ts`, it silently runs in the unit suite the
 * green-checkpoint gate depends on — so several misnamed spawned-sidecar
 * federation repro tests red-gated EVERY fleet deploy for ~73h (WI-1053). The
 * existing `guardLayeredTestPathUnderUnit` only catches the reverse direction (a
 * correctly-named integration test run BY PATH under the unit config); nothing
 * guarded a repro/heavy test MIS-NAMED as a unit test.
 *
 * The naming contract: a repro test MUST be `*.repro.integration.test.ts` (kept
 * out of the deploy gate). This meta-test lives in the gated unit suite and:
 *   (a) fixture-tests `findMisroutedReproTests` (from @papercusp/test-config), and
 *   (b) scans the whole monorepo and fails if any misrouted repro test exists —
 *       so re-introducing one reds THIS unit test with an actionable message
 *       instead of silently gating deploys.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMisroutedReproTests } from '@papercusp/test-config';

// packages/operator-core/lib → up 3 = monorepo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Pruned during descent (NOT just filtered) so the walk never enters node_modules
// et al. — a `readdirSync(root, { recursive: true })` would descend into them first.
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.vitest-tmp', '_retired']);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function collectTestFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir (e.g. a dangling submodule) — skip, never fail the walk
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) collectTestFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe('findMisroutedReproTests', () => {
  it('flags *.repro.test.<ext> in the unit layer but NOT *.repro.integration.test.ts', () => {
    const flagged = findMisroutedReproTests([
      'a/foo.repro.test.ts',
      'a/foo.repro.integration.test.ts',
      'a/bar.repro.test.tsx',
      'a/baz.test.ts',
      'a/qux.integration.test.ts',
      'a/deep.repro.integration.test.mts',
    ]);
    expect(flagged).toEqual(['a/bar.repro.test.tsx', 'a/foo.repro.test.ts']);
  });

  it('returns [] when nothing is misrouted', () => {
    expect(findMisroutedReproTests(['x.test.ts', 'y.repro.integration.test.ts'])).toEqual([]);
  });
});

describe('repro-test naming contract (deploy-gate footgun guard, WI-1091)', () => {
  it('has NO *.repro.test.ts in the unit layer anywhere in the repo', () => {
    const files = collectTestFiles(REPO_ROOT).map((f) => relative(REPO_ROOT, f));
    const misrouted = findMisroutedReproTests(files);
    expect(
      misrouted,
      misrouted.length
        ? 'Repro tests reproduce an UNFIXED bug and fail BY DESIGN, so they MUST NOT run in the unit ' +
            'deploy-gate (WI-1053 red-gated all fleet deploys ~73h this way). Rename each to ' +
            '*.repro.integration.test.ts:\n  ' +
            misrouted.join('\n  ')
        : '',
    ).toEqual([]);
  });
});
