/**
 * Types for the bash→tool substitution registry and its equivalence harness
 * (plan `bash-to-tool-substitution-2026-07-26`, P-003/P-004).
 *
 * These mirror `harness_shared.bash_tool_substitutions` (migration 665) so an
 * audit result maps onto a registry row field-for-field with no translation
 * layer to drift.
 */

/**
 * How well the proposed tool covers the real commands matching a pattern.
 * Written by the P-004 harness; enforced as a DB invariant by migration 665's
 * `tier_requires_equivalence` constraint (plan D-001).
 */
export type EquivalenceVerdict =
  /** Every sampled command has a faithful tool expression. Promotable. */
  | 'equivalent'
  /** Some sampled commands have no tool expression. Names the failures. */
  | 'needs-widening'
  /** The tool answers a different question. Never gate this pattern. */
  | 'not-a-substitute'
  /** No audit has been run yet. */
  | 'unaudited';

/**
 * Enforcement strength, reusing the three tiers the PreToolUse gate already
 * implements (plan D-003 — add no fourth mechanism).
 */
export type SubstitutionTier =
  /** Log the match; change nothing the agent sees. */
  | 'observe'
  /** Ride out as `additionalContext` on an allow — teach, never block. */
  | 'advise'
  /** Hard block. Reserved for rules that already existed independently. */
  | 'deny';

/** One real command atom drawn from the audit corpus — the evidence unit. */
export interface SampledCommand {
  /** Session that issued it (`su-…`) — lets a verdict be traced to source. */
  sid: string;
  /** ISO timestamp of the call. */
  ts: string;
  /** The NORMALISED atom (post-`atomize`), which is what the pattern matches. */
  atom: string;
}

/**
 * Whether the tool can answer the same question as one specific command.
 *
 * `covered` is the whole judgement; `reason` is what makes a `needs-widening`
 * verdict actionable rather than a shrug — D-001 requires the specific failing
 * cases be named, and this is where that text comes from.
 */
export interface CoverageResult {
  covered: boolean;
  /** Required when covered: the tool call that reproduces this command. */
  expression?: string;
  /** Required when NOT covered: precisely what the tool cannot express. */
  reason?: string;
}

/**
 * A candidate (bash pattern → tool) substitution, plus the CAPABILITY ENVELOPE
 * that decides coverage.
 *
 * `cover()` is the heart of the harness. It must model what the tool can
 * ACTUALLY express — its real args and real limits, read from the tool
 * definition — not whether the tool is nominally related to the command. A
 * `cover()` that returns `{covered:true}` for everything produces an
 * `equivalent` verdict that unlocks enforcement and then blocks agents with no
 * alternative, which is the exact failure D-001 exists to prevent.
 */
export interface SubstitutionPair {
  /** Stable registry id, e.g. `file-read.sed-range`. */
  id: string;
  /** The intent an advisory speaks about, e.g. `file-range-read`. */
  intentLabel: string;
  /** Matched against a single normalised atom. */
  bashPattern: RegExp;
  /** The tool that should have served it, e.g. `capability:read`. */
  toolName: string;
  /** Shown to the agent at tier `advise`/`deny`. */
  advisoryText: string;
  /**
   * How this pair renders as a CLAUDE.md routing row (P-019).
   *
   * The generator (`npm run gen:tool-routing`) is a PURE PROJECTION of these
   * three strings — it invents no prose and makes no judgement — so the table
   * every agent reads in its prompt and the registry the PreToolUse gate
   * enforces are the same statement of intent, and `--check` fails the build
   * when the committed file drifts from the pairs. That is the whole point of
   * P-019: prose that cannot drift from the gate.
   *
   * These are DISPLAY fields and deliberately NOT derived from the fields above:
   * a `bashPattern` source is unreadable in a table cell, and `advisoryText` is
   * a full sentence written to be read inside a hook refusal. Keep each one
   * short enough to sit in a markdown table cell.
   */
  routing: {
    /** Column 1 — the question in the agent's own words ("read a line range of one file"). */
    want: string;
    /** Column 2 — the tool call form (`capability:read { file_path, offset, limit }`). */
    use: string;
    /** Column 3 — the bash form it replaces (`sed -n '1,80p' FILE`), plus any caveat. */
    insteadOf: string;
  };
  /**
   * The verdict this pair is RECORDED as carrying. The harness recomputes the
   * verdict from the sample and asserts it still equals this — so widening the
   * tool (and its envelope) without re-recording the verdict fails the test
   * instead of silently leaving a stale row. This is the anti-rot latch.
   */
  expectedVerdict: EquivalenceVerdict;
  /**
   * OPT-IN: seed this row at a tier above `observe` instead of earning one
   * through P-020's observation window.
   *
   * Every ordinary row enters at `observe` and is promoted only by evidence —
   * that staging is the whole safety story of this registry, and this field is
   * the ONE documented way past it. It exists because D-003 recognises a second,
   * narrower class: a rule that ALREADY EXISTED INDEPENDENTLY of this plan, for
   * which the registry supplies a mechanism rather than a judgement. Such a rule
   * has nothing to observe — the decision was taken elsewhere, before the
   * pattern was ever measured.
   *
   * Guarded rather than trusted: {@link assertPolicyTier} refuses any pair whose
   * `intentLabel` does not carry the `policy-violation:` prefix, mirroring
   * migration 665's `tier_requires_equivalence` CHECK so the invariant is stated
   * in the same terms on both sides of the wire. A cost argument ("the tool is
   * cheaper") must never reach `deny` this way; only a correctness rule that
   * some human already wrote down somewhere else may.
   */
  policyTier?: SubstitutionTier;
  /** Model of what the tool can express. See the warning above. */
  cover(atom: string): CoverageResult;
}

/** The prefix an `intentLabel` must carry to be allowed a {@link SubstitutionPair.policyTier}. */
export const POLICY_INTENT_PREFIX = 'policy-violation:';

/**
 * The tier a pair actually seeds at, refusing an unauthorized escalation.
 *
 * @throws if `policyTier` is set on a pair whose intent is not a
 *   `policy-violation:` — the check that keeps "the gate enforces policy, never
 *   invents it" (D-003) a property of the code rather than of reviewer memory.
 */
export function assertPolicyTier(pair: SubstitutionPair): SubstitutionTier {
  if (pair.policyTier === undefined) return 'observe';
  if (!pair.intentLabel.startsWith(POLICY_INTENT_PREFIX)) {
    throw new Error(
      `pair ${pair.id} sets policyTier='${pair.policyTier}' but its intentLabel ` +
        `'${pair.intentLabel}' is not a '${POLICY_INTENT_PREFIX}…'. A tier above 'observe' is ` +
        'earned by P-020 observation, or authorized by a pre-existing rule (D-003) — never asserted.',
    );
  }
  return pair.policyTier;
}

/** A sampled command the tool could not express, with the reason why. */
export interface FailingCase {
  atom: string;
  reason: string;
  sid: string;
}

/** The audit result for one pair — maps directly onto a registry row. */
export interface PairAudit {
  pairId: string;
  intentLabel: string;
  /** `bashPattern.source` — the string the registry stores. */
  bashPattern: string;
  /**
   * `bashPattern.flags`, minus the stateful ones — the registry's companion
   * column (migration 667). Stored SEPARATELY from the source because a
   * consumer recompiling `new RegExp(source)` without them gets a DIFFERENT
   * regex from the one the verdict was earned under, which silently divorces
   * enforcement from its evidence (WI-5998).
   */
  bashPatternFlags: string;
  toolName: string;
  verdict: EquivalenceVerdict;
  /** How many real commands were tested (`sample_size`). */
  sampleSize: number;
  coveredCount: number;
  /** Deduplicated, capped — the `failing_cases` jsonb payload. */
  failingCases: FailingCase[];
  /** Distinct sessions represented in the sample. */
  sessionCount: number;
  /**
   * The highest tier this verdict permits, per D-001. `deny` is never derived:
   * it is a separate policy call reserved for rules that already exist (D-003).
   */
  maxTier: SubstitutionTier;
}
