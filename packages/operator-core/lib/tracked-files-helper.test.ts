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

  it('recurses into submodules — the defect the helper exists to fix', () => {
    // libs/generic/sync is a submodule; a bare `git ls-files` emits ONE gitlink
    // entry for it and none of its contents.
    expect(
      scan.files.some((f) => f.startsWith('libs/generic/sync/src/')),
      'no libs/generic/sync/src files — the enumerator is not recursing',
    ).toBe(true);
    expect(scan.files.some((f) => f.startsWith('libs/papercusp/packages/'))).toBe(true);
  });

  it('reports declared-but-unscanned submodules instead of silently dropping them', () => {
    // The contract: coverage is part of the return value, so a caller cannot
    // mistake "not scanned" for "clean". Asserted structurally — which submodules
    // are initialized varies by checkout, and pinning a specific one would make
    // this test a checkout detector rather than a contract test.
    expect(scan.declared.length).toBeGreaterThan(30);
    expect(new Set([...scan.scanned, ...scan.unscanned])).toEqual(new Set(scan.declared));
    expect(scan.scanned.length).toBeGreaterThan(0);
    for (const path of scan.unscanned) {
      expect(scan.files.some((f) => f.startsWith(`${path}/`))).toBe(false);
    }
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
