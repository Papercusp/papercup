/**
 * Gate-resilience plan (gate-resilience-vs-torn-git-sync-sweeps-retry-failing-files-2026-08-14)
 * Decisions D-004 and D-005 REJECTED two mechanisms. Each rejection is a claim about
 * CODE, so each is pinned here as a falsifiable check rather than left as rubric prose
 * (acceptance rubric C4/C5 bind their structured checks to this file).
 *
 * Vetting finding this file discharges (su-1d899d11, msg mt8d0oxk, 2026-08-25):
 * `check:null` asked a grader to confirm an ABSENCE with no named falsifier and no
 * positive control — the false-absence shape where a broken search instrument looks
 * identical to a genuine absence. So every absence assertion below is paired with a
 * POSITIVE CONTROL over the same bytes, proving the instrument read real content.
 *
 *   D-005 (C4): the refire-reserve mechanism stays REJECTED — no half-implementation
 *   in the release path. Forbidden identifiers: refire-reserve / refireReserve /
 *   reserveRefire (any hyphen/underscore/camel spelling). Control: the plain token
 *   `refire` MUST still appear in the same files (the retriage/refire path exists).
 *
 *   D-004 (C5): per-package atomic sweeps stay REJECTED — git-sync remains WHOLE-TREE.
 *   The positive half is pinned to the file + symbol that performs the sweep:
 *   packages/operator-core/lib/harness/git-sync/run-git-sync.ts, `syncOneRepo`,
 *   which builds the whole-tree `['add', '-A']` argv (see ~:2487). Forbidden
 *   identifiers: perPackageSweep / per-package-atomic / atomicSweep /
 *   packageScopedSweep. Control: `syncOneRepo` MUST still be present.
 *
 * If either mechanism is legitimately adopted later (a superseding plan Decision),
 * this guard fails in the same change and forces the rubric + Decisions to be
 * updated together. It fails on DRIFT, not on the current answer being wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const RELEASE_PATH_FILES = [
  'apps/operator/lib/release/green-checkpoint.ts',
  'packages/operator-core/lib/harness/routines/release-actions.ts',
] as const;

const GIT_SYNC_IMPL = 'packages/operator-core/lib/harness/git-sync/run-git-sync.ts';

const read = (repoRel: string): string => readFileSync(join(ROOT, repoRel), 'utf8');

describe('D-005: refire-reserve stays rejected in the release path (rubric C4)', () => {
  // Any spelling of the rejected mechanism: refire-reserve, refire_reserve,
  // refireReserve, reserve-refire, reserveRefire, ...
  const FORBIDDEN = /refire[-_]?reserve|reserve[-_]?refire/i;

  for (const file of RELEASE_PATH_FILES) {
    it(`${file}: no refire-reserve identifier survives`, () => {
      const source = read(file);
      const hits = source.split('\n').flatMap((text, i) => (FORBIDDEN.test(text) ? [`${i + 1}: ${text.trim()}`] : []));
      expect(hits, `D-005 rejected mechanism present:\n${hits.join('\n')}`).toEqual([]);
    });

    it(`${file}: positive control — the plain 'refire' token is present (instrument reads real bytes)`, () => {
      // The retriage/refire path genuinely exists in the release code; if this
      // control ever fails, the absence assertions above are measuring nothing.
      expect(/refire/i.test(read(file))).toBe(true);
    });
  }
});

describe('D-004: git-sync remains whole-tree; per-package atomic sweeps stay rejected (rubric C5)', () => {
  const FORBIDDEN = /perPackageSweep|per-package-atomic|atomicSweep|packageScopedSweep/i;

  it('run-git-sync.ts: the whole-tree sweep argv is present in code (add -A)', () => {
    // The POSITIVE half of D-004, pinned to code rather than prose: the sweep
    // builds a whole-tree `git add -A` argv (run-git-sync.ts ~:2487, used by
    // syncOneRepo). A per-package rescope would remove or bypass this argv.
    const source = read(GIT_SYNC_IMPL);
    expect(source.includes(`'add', '-A'`)).toBe(true);
  });

  it('run-git-sync.ts: the sweep symbol syncOneRepo is present (positive control + anchor)', () => {
    expect(/function syncOneRepo\(/.test(read(GIT_SYNC_IMPL))).toBe(true);
  });

  it('run-git-sync.ts: no per-package sweep-scoping identifier survives', () => {
    const source = read(GIT_SYNC_IMPL);
    const hits = source.split('\n').flatMap((text, i) => (FORBIDDEN.test(text) ? [`${i + 1}: ${text.trim()}`] : []));
    expect(hits, `D-004 rejected mechanism present:\n${hits.join('\n')}`).toEqual([]);
  });
});
