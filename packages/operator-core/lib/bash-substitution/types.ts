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
   * The verdict this pair is RECORDED as carrying. The harness recomputes the
   * verdict from the sample and asserts it still equals this — so widening the
   * tool (and its envelope) without re-recording the verdict fails the test
   * instead of silently leaving a stale row. This is the anti-rot latch.
   */
  expectedVerdict: EquivalenceVerdict;
  /** Model of what the tool can express. See the warning above. */
  cover(atom: string): CoverageResult;
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
