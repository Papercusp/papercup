/**
 * R-7 of generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 (P-007).
 *
 * R-7, verbatim: "Every acceptance-routing behavior pinned by this plan's bar set is
 * covered by at least one committed test in the repository's own test framework that
 * fails when that behavior is reverted."
 *
 * Note what that sentence does NOT say. It does not say a test EXISTS per bar; a test
 * that passes whether or not the behavior is present is not coverage, it is decoration.
 * The load-bearing clause is "fails when that behavior is reverted" — a claim about a
 * counterfactual, which no amount of reading the test can settle. So this module keeps
 * the MEASURED falsifiability verdict beside each mapping, and `validateBarTestCoverage`
 * treats a bar whose probe did not CATCH its mutant as uncovered, exactly as if no test
 * existed at all. An unprobed mapping is a claim; a caught mutant is evidence.
 *
 * Why a map rather than a naming convention: the bars and their tests do not correspond
 * one-to-one (R-5 is pinned by two tests across two subjects; one test file pins both
 * R-5 and R-6), so any convention that recovers the relation from filenames would have
 * to encode that fan-out in the names. The relation is data; it is stored as data.
 *
 * Reuse note: this is deliberately NOT a second acceptance-bar registry. The sibling
 * `acceptance-bar-*` modules answer "what bars does this plan HAVE and are they met";
 * this one answers the strictly different "is each bar's pinned behavior guarded by a
 * test that can actually fail". No existing surface carried the test↔bar relation or a
 * falsifiability verdict, which is why this adds one field-set rather than a mechanism.
 */

/** Verdict from `scripts/mutation-probe.sh` for a bar's named test. */
export type BarProbeVerdict = 'caught' | 'survived' | 'not-probed';

/** Which falsifiability tier produced the verdict (CLAUDE.md § "Proving a guard is falsifiable"). */
export type BarProbeTier = 'copy-out' | 'in-tree' | 'historical' | 'paired-control';

export interface BarTestCoverageEntry {
  /** Bar key as it appears in the plan's rubric, e.g. `R-4`. */
  readonly barKey: string;
  /** The plan spec id this entry covers, e.g. `AUTO-BAR-R-4-P-004`. */
  readonly specId: string;
  /** The plan item the spec hangs off, e.g. `P-004`. */
  readonly planItemId: string;
  /** Repo-relative path of the committed test that pins the behavior. */
  readonly testPath: string;
  /** Repo-relative path of the production subject whose reversion the test must catch. */
  readonly subjectPath: string;
  /** The exact reversion applied to `subjectPath` when the verdict was measured. */
  readonly mutation: string;
  readonly probeTier: BarProbeTier;
  readonly probeVerdict: BarProbeVerdict;
}

export interface BarTestCoverageInput {
  /** Every bar key the plan's bar set requires coverage for. */
  readonly requiredBarKeys: readonly string[];
  readonly entries: readonly BarTestCoverageEntry[];
  /** Does the test file exist on disk? */
  readonly fileExists: (path: string) => boolean;
  /** Is the test file tracked by git — i.e. COMMITTED, not merely present? */
  readonly isTracked: (path: string) => boolean;
}

export interface BarTestCoverageReport {
  readonly ok: boolean;
  /** Required bars with no mapping at all. */
  readonly barsWithoutEntry: string[];
  /** Bars that have a mapping, but no mapping whose mutant was CAUGHT. */
  readonly unfalsifiedBars: string[];
  /** Mapped test paths absent from disk. */
  readonly missingTestFiles: string[];
  /** Mapped test paths present but untracked — present for me, absent for everyone else. */
  readonly untrackedTestFiles: string[];
  /** Bars with at least one existing, tracked, mutant-catching test. */
  readonly coveredBars: string[];
}

/**
 * Pure, dependency-injected so the guard test can drive it with deliberately-wrong
 * maps (its permanent controls) as well as the real one. Keeping the fs/git reads
 * behind `fileExists`/`isTracked` is what makes those controls possible at all.
 */
export function validateBarTestCoverage(input: BarTestCoverageInput): BarTestCoverageReport {
  const byBar = new Map<string, BarTestCoverageEntry[]>();
  for (const entry of input.entries) {
    const list = byBar.get(entry.barKey);
    if (list) list.push(entry);
    else byBar.set(entry.barKey, [entry]);
  }

  const barsWithoutEntry: string[] = [];
  const unfalsifiedBars: string[] = [];
  const coveredBars: string[] = [];

  for (const barKey of input.requiredBarKeys) {
    const entries = byBar.get(barKey) ?? [];
    if (entries.length === 0) {
      barsWithoutEntry.push(barKey);
      continue;
    }
    // A bar is covered by an entry only if that entry is simultaneously: present on
    // disk, tracked, and measured to FAIL on reversion. Splitting these into separate
    // top-level lists would let a bar count as covered on the strength of one entry's
    // existence and a DIFFERENT entry's probe verdict.
    const covering = entries.filter(
      (entry) =>
        entry.probeVerdict === 'caught' &&
        input.fileExists(entry.testPath) &&
        input.isTracked(entry.testPath),
    );
    if (covering.length === 0) {
      unfalsifiedBars.push(barKey);
      continue;
    }
    coveredBars.push(barKey);
  }

  const missingTestFiles: string[] = [];
  const untrackedTestFiles: string[] = [];
  for (const entry of input.entries) {
    if (!input.fileExists(entry.testPath)) {
      missingTestFiles.push(entry.testPath);
      continue;
    }
    if (!input.isTracked(entry.testPath)) untrackedTestFiles.push(entry.testPath);
  }

  return {
    ok:
      barsWithoutEntry.length === 0 &&
      unfalsifiedBars.length === 0 &&
      missingTestFiles.length === 0 &&
      untrackedTestFiles.length === 0,
    barsWithoutEntry,
    unfalsifiedBars,
    missingTestFiles,
    untrackedTestFiles,
    coveredBars,
  };
}
