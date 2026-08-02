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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs guard helper, no type declarations (same import shape
// as the other guard tests, e.g. dbos/no-raw-setinterval-guard.test.ts).
// ⚠ Keep this import on ONE line: `@ts-expect-error` suppresses only the line
// immediately following it, so wrapping it across lines makes the directive
// "unused" AND leaves the module specifier line unsuppressed — two errors, not zero.
// eslint-disable-next-line prettier/prettier
import { coverageOf, declaredSubmodules, describeUnscanned, listTrackedFiles } from '../../../scripts/lib/tracked-files.mjs';

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
    // The RATIO is the load-bearing part: "0/39" cannot be misread as clean, where
    // a bare ✓ over an empty scan reads exactly like a pass (WI-6776).
    expect(note).toMatch(/coverage \d+\/\d+ declared submodule\(s\) enumerated/);
    expect(note).toContain('says nothing about them');
  });

  it('describeUnscanned diagnoses the CAUSE by tree shape, not "not initialized" for everything', () => {
    // WI-6776. The first version reported every gap as "not initialized". Measured
    // 2026-08-02 in papercusp-release: 0/39 submodules enumerated while 38 are checked
    // out WITH CONTENT ON DISK — submodule source is `git archive`-extracted by
    // setup-release-checkout.sh, so there is no `.git` for --recurse-submodules to
    // descend into. "Not initialized" sends a reader to `git submodule update --init`
    // chasing a fault that does not exist, which is the wasted-diagnostic-time cost
    // EI-19301033966613245 was filed about.
    //
    // Both branches are driven with ordinary repo paths rather than real submodules, so
    // this is deterministic in any checkout: `scripts` always has content, and the
    // nonexistent path never does.
    const present = describeUnscanned(['scripts']) as string;
    expect(present).toContain('present on disk but NOT git-enumerable');
    expect(present).toContain('BY DESIGN');
    expect(present).not.toContain('not initialized');

    const absent = describeUnscanned(['libs/definitely-not-checked-out-here']) as string;
    expect(absent).toContain('not initialized');
    expect(absent).not.toContain('present on disk');
  });

  it('coverageOf partitions an already-computed file list, so a guard can keep its own enumerator', () => {
    // The seam that made WI-6776 fixable without forcing every guard onto one `git`
    // invocation: check-no-nul-in-source and check-no-control-bytes need `-z` output
    // (a guard about byte-level corruption must not assume filenames are newline-free)
    // and check-env-feature-gates uses `git grep`. What they share is the coverage
    // CONTRACT, not the command.
    const { declared, scanned, unscanned } = coverageOf(['libs/generic/sync/src/x.ts', 'package.json']) as {
      declared: string[];
      scanned: string[];
      unscanned: string[];
    };
    expect(scanned).toEqual(['libs/generic/sync']);
    expect(new Set([...scanned, ...unscanned])).toEqual(new Set(declared));
    // An empty list must report ZERO coverage, never full — the false-clean direction.
    const empty = coverageOf([]) as { scanned: string[]; unscanned: string[] };
    expect(empty.scanned).toEqual([]);
    expect(empty.unscanned.length).toBeGreaterThan(30);
  });

  it('splits unscanned into present-on-disk vs absent, so an alarm can key on the serious one', () => {
    // WI-6776. The two gaps are not equally serious and a caller that ACTS on coverage
    // must tell them apart. `unscannedPresent` means git failed to read files that are
    // really there (release-shaped checkout / linked worktree) — the scan is missing real
    // content. `unscannedAbsent` means nothing is checked out, which contributes no files
    // anywhere and so does not shrink the scan relative to reality.
    //
    // This matters because this repo PERMANENTLY carries one absent submodule
    // (libs/zero-harness, retired and deliberately uninitialized). An alarm keyed on
    // `unscanned` therefore fires on every run in a totally healthy tree, gets trained
    // away, and is worth nothing on the day the tree really is broken. check-vacuous-
    // negative-assertions keys its "corpus was INCOMPLETE" warning on unscannedPresent
    // for exactly this reason.
    const cov = coverageOf([]) as {
      unscanned: string[];
      unscannedPresent: string[];
      unscannedAbsent: string[];
    };
    // Exhaustive + disjoint: nothing may fall through the split.
    expect(new Set([...cov.unscannedPresent, ...cov.unscannedAbsent])).toEqual(new Set(cov.unscanned));
    expect(cov.unscannedPresent.filter((p) => cov.unscannedAbsent.includes(p))).toEqual([]);
    // Non-vacuity: with NO files supplied, every checked-out submodule must land in
    // `present` — an always-empty `present` would silence the alarm this exists to raise.
    expect(cov.unscannedPresent.length).toBeGreaterThan(30);
  });
});

/**
 * WI-6776 — the ratchet. Migrating today's guards fixes today's guards; it does not
 * stop the next one from enumerating the tree and printing a bare ✓ over subtrees it
 * never opened. This asserts the CONTRACT rather than a file list, so a new recursing
 * script has to opt in (or state a reason) instead of silently reintroducing the class.
 *
 * Note the glob is `scripts/*.mjs`, NOT `scripts/check-*.mjs`: the parent item listed
 * three offenders because it globbed `check-*`, and that missed `scan-retirement-surface.mjs`
 * (recurses, different prefix) as well as `check-env-feature-gates.mjs`.
 */
describe('recursing guards must report coverage (WI-6776 ratchet)', () => {
  const scriptsDir = fileURLToPath(new URL('../../../scripts', import.meta.url));

  /**
   * Scripts that recurse but legitimately need no coverage line. Each entry states WHY —
   * an unexplained entry is how a ratchet quietly becomes a rubber stamp.
   */
  const ALLOW = new Map<string, string>([
    [
      'lib/tracked-files.mjs',
      'IS the shared helper — it defines the coverage contract rather than consuming it.',
    ],
  ]);

  /** Every .mjs under scripts/, including subdirectories, as a scripts/-relative path. */
  const listMjs = (dir: string, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? listMjs(join(dir, e.name), `${prefix}${e.name}/`)
        : e.name.endsWith('.mjs')
          ? [`${prefix}${e.name}`]
          : [],
    );

  const recursing = listMjs(scriptsDir).filter((f) =>
    readFileSync(join(scriptsDir, f), 'utf8').includes('recurse-submodules'),
  );

  it('finds the recursing scripts at all (a zero here would make this suite vacuous)', () => {
    expect(recursing.length).toBeGreaterThanOrEqual(4);
    expect(recursing).toContain('check-no-control-bytes.mjs');
  });

  it.each(recursing)('%s reports what its scan did NOT cover', (file) => {
    if (ALLOW.has(file)) return;
    const text = readFileSync(join(scriptsDir, file), 'utf8');
    expect(
      text.includes('describeUnscanned') || text.includes('coverageOf'),
      `${file} enumerates the tree with --recurse-submodules but never reports coverage.\n` +
        `In a release-shaped checkout (papercusp-checkpoint / papercusp-release: submodule source is\n` +
        `git archive-extracted, so there is no .git to descend into) that scan reaches ZERO submodule\n` +
        `files and still prints success — a confident ✓ over ~22% of the tree it never opened.\n` +
        `FIX: import { coverageOf, describeUnscanned } from './lib/tracked-files.mjs' and append the\n` +
        `suffix to the success message. If this script genuinely needs no coverage line, add it to\n` +
        `ALLOW in this test WITH A REASON.`,
    ).toBe(true);
  });
});
