/**
 * The equivalence harness (plan `bash-to-tool-substitution-2026-07-26`, P-004).
 *
 * THE METHOD, in one sentence: draw REAL commands matching a pattern from the
 * audit corpus, ask the proposed tool's capability envelope whether it can
 * express each one, and DERIVE the verdict from the answers.
 *
 * The verdict is derived, never asserted. That is the whole design. A
 * hand-written verdict rots the moment someone widens the tool; a derived one
 * changes automatically and trips `expectedVerdict` on the pair, forcing the
 * registry row to be re-recorded (see `types.ts`).
 *
 * ── Why the bar is 100% coverage (plan D-008) ────────────────────────────────
 * A partial verdict is tempting — "19 of 20, close enough" — and it is wrong,
 * because the PATTERN is the unit of enforcement. Every command the pattern
 * matches gets the advisory; if one of them has no tool form, that agent is
 * told to use a tool that cannot do the job. The fix for a near-miss is NOT to
 * lower the bar but to NARROW THE PATTERN until the residue falls outside it,
 * or to widen the tool. Both outcomes are good; a 95% threshold produces
 * neither and quietly ships the broken 5%.
 *
 * This is why the file-read family is four patterns rather than one: three of
 * them reach `equivalent` and can teach immediately, and only `tail` is held at
 * `observe` pending a real widening. One blurry family-wide verdict would have
 * stalled all four.
 */

import type {
  CoverageResult,
  EquivalenceVerdict,
  FailingCase,
  PairAudit,
  SampledCommand,
  SubstitutionPair,
  SubstitutionTier,
} from './types';

/**
 * Minimum sample size for a verdict to count (the plan specifies N=20).
 * Below this, a pattern is too rare — or too narrow — to have earned a verdict,
 * and `auditPair` throws rather than returning a confident-looking result built
 * on three commands.
 */
export const MIN_SAMPLE_SIZE = 20;

/** Cap on stored failing cases: enough to act on, small enough for a jsonb column. */
const MAX_FAILING_CASES = 25;

/** Select the atoms from a corpus that a pair's pattern claims. */
export function matchingAtoms(pair: SubstitutionPair, corpus: SampledCommand[]): SampledCommand[] {
  // A regex with /g is stateful across .test() calls; rebuild without it.
  const pattern = new RegExp(pair.bashPattern.source, pair.bashPattern.flags.replace(/g/g, ''));
  return corpus.filter((entry) => pattern.test(entry.atom));
}

/**
 * Run the harness for one pair against a corpus of real sampled commands.
 *
 * @throws if the pattern matches fewer than {@link MIN_SAMPLE_SIZE} commands —
 *   an under-sampled verdict is worse than no verdict, because it looks equally
 *   authoritative in the registry.
 */
export function auditPair(pair: SubstitutionPair, corpus: SampledCommand[]): PairAudit {
  const sample = matchingAtoms(pair, corpus);

  if (sample.length < MIN_SAMPLE_SIZE) {
    throw new Error(
      `[equivalence] pair "${pair.id}" matched only ${sample.length} of ${corpus.length} corpus atoms ` +
        `(need >= ${MIN_SAMPLE_SIZE}). Either the pattern is wrong, or this intent is too rare to enforce — ` +
        `do not record a verdict from this sample.`,
    );
  }

  const failing: FailingCase[] = [];
  const seenReasons = new Set<string>();
  let coveredCount = 0;

  for (const entry of sample) {
    let result: CoverageResult;
    try {
      result = pair.cover(entry.atom);
    } catch (e: unknown) {
      // An envelope that throws is treated as "cannot express" rather than
      // failing the whole audit: a crash on one weird atom is itself evidence
      // the tool does not cover it.
      result = { covered: false, reason: `envelope error: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (result.covered) {
      coveredCount += 1;
      continue;
    }

    const reason = result.reason ?? 'no reason recorded';
    // Deduplicate by REASON, not by command: twenty `tail -f` atoms are one
    // finding, and the registry row should say so once.
    if (!seenReasons.has(reason) && failing.length < MAX_FAILING_CASES) {
      seenReasons.add(reason);
      failing.push({ atom: entry.atom, reason, sid: entry.sid });
    }
  }

  const verdict = deriveVerdict(coveredCount, sample.length);

  return {
    pairId: pair.id,
    intentLabel: pair.intentLabel,
    bashPattern: pair.bashPattern.source,
    toolName: pair.toolName,
    verdict,
    sampleSize: sample.length,
    coveredCount,
    failingCases: failing,
    sessionCount: new Set(sample.map((entry) => entry.sid)).size,
    maxTier: maxTierFor(verdict),
  };
}

/**
 * The derivation rule (D-008). Total coverage or it is not equivalent.
 */
export function deriveVerdict(coveredCount: number, sampleSize: number): EquivalenceVerdict {
  if (sampleSize === 0) return 'unaudited';
  if (coveredCount === sampleSize) return 'equivalent';
  if (coveredCount === 0) return 'not-a-substitute';
  return 'needs-widening';
}

/**
 * The ceiling a verdict permits — the code-side mirror of migration 665's
 * `tier_requires_equivalence` CHECK constraint.
 *
 * Note `deny` is never returned. Per D-003 the registry teaches by default and
 * blocks only where the rule already existed independently (the shared-tree git
 * guard, the systemd scheduler lockout), so `deny` is a deliberate policy entry
 * a human writes — never something an equivalence score unlocks.
 */
export function maxTierFor(verdict: EquivalenceVerdict): SubstitutionTier {
  return verdict === 'equivalent' ? 'advise' : 'observe';
}

/**
 * Render an audit as the registry row it becomes. Keeps the field mapping in
 * ONE place so P-018's seeding cannot drift from what the harness measured.
 */
export function auditToRegistryRow(
  audit: PairAudit,
  pair: SubstitutionPair,
  evidenceRef: string,
): {
  intent_label: string;
  bash_pattern: string;
  tool_name: string;
  equivalence_verdict: EquivalenceVerdict;
  sample_size: number;
  failing_cases: FailingCase[];
  evidence_ref: string;
  tier: SubstitutionTier;
  advisory_text: string;
  baseline_sessions: number;
} {
  return {
    intent_label: audit.intentLabel,
    bash_pattern: audit.bashPattern,
    tool_name: audit.toolName,
    equivalence_verdict: audit.verdict,
    sample_size: audit.sampleSize,
    failing_cases: audit.failingCases,
    evidence_ref: evidenceRef,
    // Always enter at `observe`; promotion to `advise` is P-020's staged
    // decision after a real observation window, never automatic on a green
    // verdict. `maxTier` states what the verdict PERMITS, not what it does.
    tier: 'observe',
    advisory_text: pair.advisoryText,
    baseline_sessions: audit.sessionCount,
  };
}
