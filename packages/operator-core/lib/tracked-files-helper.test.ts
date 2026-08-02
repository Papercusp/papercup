/**
 * scripts/lib/tracked-files.mjs — the shared tree enumerator every check-*.mjs
 * guard uses (WI-6730).
 *
 * WHY THIS FILE EXISTS: the helper's whole purpose is to stop a guard reporting a
 * confident ✓ over a subtree it never opened. Every failure mode of the helper is
 * therefore SILENT by construction — it returns fewer files, every caller finds
 * nothing, and every caller prints success. There is no crash to notice. So the
 * properties below are pinned rather than left to inspection.
 *
 * Both bugs asserted here were real and were caught by measurement, not review:
 *   1. a bare `git ls-files` skipping all 39 submodules (the original defect), and
 *   2. this module's own ROOT resolving to `scripts/` instead of the repo root,
 *      which silently reduced the default enumeration to ~33 files.
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs guard helper, no type declarations (same import shape
// as the other guard tests, e.g. dbos/no-raw-setinterval-guard.test.ts).
import { declaredSubmodules, describeUnscanned, listTrackedFiles } from '../../../scripts/lib/tracked-files.mjs';

describe('tracked-files helper (WI-6730)', () => {
  const scan = listTrackedFiles() as {
    files: string[];
    declared: string[];
    scanned: string[];
    unscanned: string[];
  };

  it('enumerates the REPO ROOT by default, not the scripts/ directory it lives in', () => {
    // The regression: this module sits at scripts/lib/, one level deeper than the
    // scripts/check-*.mjs guards that use `new URL('..', import.meta.url)`. Copying
    // that idiom verbatim resolved ROOT to scripts/ and returned ~33 files — enough
    // for a caller to run, find nothing, and report clean.
    expect(scan.files.length).toBeGreaterThan(5_000);
    // Files that exist only OUTSIDE scripts/ — a scripts/-rooted scan finds neither.
    expect(scan.files).toContain('package.json');
    expect(scan.files.some((f) => f.startsWith('packages/operator-core/'))).toBe(true);
  });

  it('recurses into submodules WHERE GIT CAN — and the scanned/unscanned split says which', () => {
    // ⚠ Do NOT assert "libs/generic/sync/src files are present" unconditionally.
    // `git ls-files --recurse-submodules` DOES NOT WORK IN A LINKED WORKTREE whose
    // submodules are not registered: it silently returns FEWER paths than a plain
    // `git ls-files` (measured in the green-checkpoint worktree: 20,060 vs 20,098,
    // and zero under libs/generic/sync/src) even though the files are on disk. An
    // unconditional assertion here therefore passes in the shared tree and reds the
    // fleet gate — which is exactly what it did on candidate 3a18e44b.
    //
    // The real contract is a BICONDITIONAL, and it is what makes the helper safe to
    // trust in either environment: a submodule's files appear iff that submodule is
    // reported as scanned. Both directions are checked, so this cannot pass by the
    // enumerator simply returning nothing.
    for (const path of scan.scanned) {
      expect(
        scan.files.some((f) => f.startsWith(`${path}/`)),
        `${path} is reported SCANNED but contributed no files — the split is lying`,
      ).toBe(true);
    }
    for (const path of scan.unscanned) {
      expect(
        scan.files.some((f) => f.startsWith(`${path}/`)),
        `${path} is reported UNSCANNED but contributed files — the split is lying`,
      ).toBe(false);
    }
  });

  it('accounts for every declared submodule — none may be silently dropped', () => {
    // Coverage is part of the return value, so a caller cannot mistake "not
    // scanned" for "clean". Which submodules are initialized varies by checkout
    // (see above), so this asserts the PARTITION rather than a specific outcome.
    expect(scan.declared.length).toBeGreaterThan(30);
    expect(new Set([...scan.scanned, ...scan.unscanned])).toEqual(new Set(scan.declared));
    // Disjoint: a submodule cannot be both.
    expect(scan.scanned.filter((p) => scan.unscanned.includes(p))).toEqual([]);
  });

  it('declaredSubmodules reads .gitmodules and is sorted + deduped', () => {
    const declared = declaredSubmodules() as string[];
    expect(declared).toEqual([...declared].sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toContain('libs/generic/sync');
  });

  it('describeUnscanned is empty for full coverage and names the gaps otherwise', () => {
    // Non-vacuity: an always-empty formatter would satisfy the "full coverage"
    // half of this contract while making every gap invisible — the exact class of
    // silent pass this helper exists to prevent.
    expect(describeUnscanned([])).toBe('');
    const note = describeUnscanned(['libs/zero-harness']) as string;
    expect(note).toContain('libs/zero-harness');
    expect(note).toContain('NOT scanned');
  });
});
