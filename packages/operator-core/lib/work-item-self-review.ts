/**
 * ARM B of the three-arm pilot (`directed-pair-work-items-2026-08-25` P-005, D-007): a solo
 * agent plus a forced, ledger-checked self-review before `work_items:complete`.
 *
 * ## Why this is not another completion gate
 *
 * `work_items:complete` already runs a large pre-completion battery — `authorityForCompletion`
 * plus the detectors in `agent-tools/work_items/complete.ts` (unresolved paths, path vintage,
 * pre-existing changed paths, typecheck-evidence gap, prescribed recurrence guard, the
 * `verification.coverage` partition). Every one of those validates the completion RECORD: is
 * it well formed, and does it correspond to the repo?
 *
 * None of them forces a second JUDGMENT PASS over the code. The existing gates ask "is your
 * report honest and complete?"; the pair (D-002) asks "did someone look at this work again,
 * critically, and find something?" Arm B is the second question, asked of the author. It
 * EXTENDS that battery and must never duplicate it — arm B's whole thesis is that the cheap
 * structural check captures most of the pair's value, so a second redundant gate would
 * confound the very comparison the pilot exists to measure.
 *
 * ## Why corroboration is the load-bearing part
 *
 * D-002 rules that pasted output is a claim, not evidence. A self-review is the case where an
 * unverified claim is cheapest to make: nobody else was there, and the reviewer is the author.
 * So the claim "I re-read the diff" is checked against `harness_shared.tool_invocations` the
 * way `testsRun` is checked against `testing:runs` — otherwise arm B measures an agent's
 * willingness to type a sentence.
 *
 * Two traps this module is deliberately built around, both found by measurement rather than
 * assumed:
 *
 * 1. **A review must post-date the last edit.** Reading the diff and then editing again means
 *    the shipped state was never reviewed. This is the check most likely to be omitted,
 *    because the transcript still *contains* a diff read and looks compliant.
 * 2. **A workspace-scoped su session logs `harness_slug='*'`, not the item's harness**
 *    (EI-21476445557415319). A corroboration query scoped by the item's harness returns a
 *    clean zero for those sessions — a FALSE ABSENCE indistinguishable from "no review
 *    happened". Callers must select ledger rows by `workspace_id + coord_owner_id` and treat
 *    `'*'` as matching. This module takes already-selected rows so that the trap lives at one
 *    documented seam instead of being re-derived per call site.
 */

/**
 * The ledger selection, as SQL text + values. Exported as data rather than executed here so
 * the predicate itself is testable and so the two traps below live at ONE reviewable seam.
 *
 * ⚠ **No `harness_slug` predicate, deliberately** (EI-21476445557415319). A workspace-scoped
 * su session files its calls under `harness_slug='*'`, so scoping by the item's harness
 * returns a clean zero for exactly those sessions — a FALSE ABSENCE that reads identically to
 * "no review happened" and would refuse an honest completion. `workspace_id +
 * coord_owner_id + goal_ref` is already a tighter scope than adding the harness would be.
 *
 * ⚠ **`goal_ref IS NULL` is admitted, deliberately.** The column is populated on roughly 86%
 * of agent-origin calls (measured, this workspace, 6h window), so requiring it would drop
 * real review calls. The rows are already pinned to this agent and to the window since this
 * item was claimed, so a null-goal call in that window is overwhelmingly this item's work.
 *
 * The direction of that choice is the point: being slightly permissive risks crediting a
 * review performed for a neighbouring item, while being strict risks REFUSING an honest close
 * on the fleet's hot path and corrupting the pilot arm with false refusals. For an
 * experimental gate the second failure is far worse than the first, so this errs permissive
 * and records `rubberStampRisk` / `yieldedChange` to keep the arm measurable regardless.
 */
export function selfReviewLedgerQuery(args: {
  workspaceId: string;
  coordOwnerId: string;
  goalRef: string;
  sinceMs: number;
}): { text: string; values: unknown[] } {
  return {
    text: `SELECT tool_name, invoked_at, status
             FROM harness_shared.tool_invocations
            WHERE workspace_id = $1
              AND coord_owner_id = $2
              AND (goal_ref = $3 OR goal_ref IS NULL)
              AND invoked_at >= $4
            ORDER BY invoked_at ASC`,
    values: [args.workspaceId, args.coordOwnerId, args.goalRef, new Date(args.sinceMs)],
  };
}

/** Narrow a raw ledger row to the shape the verdict depends on. */
export function toSelfReviewLedgerRow(raw: {
  tool_name?: unknown;
  invoked_at?: unknown;
  status?: unknown;
}): SelfReviewLedgerRow | undefined {
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  if (!toolName) return undefined;
  const at = raw.invoked_at;
  const invokedAtMs =
    at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(invokedAtMs)) return undefined;
  return {
    toolName,
    invokedAtMs,
    status: typeof raw.status === 'string' ? raw.status : undefined,
  };
}

/** A ledger row, narrowed to what a review verdict actually depends on. */
export interface SelfReviewLedgerRow {
  readonly toolName: string;
  readonly invokedAtMs: number;
  /** `status` from the ledger; a refused/errored call never counts as having reviewed. */
  readonly status?: string;
}

export interface SelfReviewEvidence {
  /** What was re-read — the diff, the changed files. Free text, corroborated separately. */
  readonly lookedAt?: string;
  /**
   * What the review turned up. An EMPTY array is a legitimate, recorded outcome — never
   * silently coerced to "fine". See `rubberStampRisk`.
   */
  readonly findings?: readonly string[];
  /** What was fixed because of the review. */
  readonly changedAsResult?: readonly string[];
}

export type SelfReviewVerdict =
  | 'corroborated'
  | 'uncorroborated'
  | 'stale-review'
  | 'not-claimed';

export interface SelfReviewJudgement {
  readonly verdict: SelfReviewVerdict;
  /** Ledger rows that count as a review of the shipped state. */
  readonly reviewCalls: readonly SelfReviewLedgerRow[];
  /**
   * True when the review is corroborated AND reported zero findings. Not a failure — a
   * MEASUREMENT. D-002's rubber-stamp warning applies harder to self-review than to a
   * director, because the reviewer shares the author's context and is anchored on it the
   * way D-005's third round is anchored.
   */
  readonly rubberStampRisk: boolean;
  /** Arm-B pilot metric: did the review change anything? Feeds the per-arm review YIELD. */
  readonly yieldedChange: boolean;
  readonly reason?: string;
}

/**
 * Tools whose invocation constitutes actually looking at the code again.
 *
 * Deliberately NARROW. A broad list would let incidental traffic (a `plans:get`, a
 * `coord:send`) corroborate a review nobody performed, which is the failure mode that makes
 * a gate worse than no gate: it manufactures evidence rather than merely missing it.
 */
const REVIEW_TOOLS: readonly string[] = [
  'capability:git', // the diff itself
  'capability:read', // re-reading a changed file
  'code:review',
  'lsp:query', // checking a symbol's real callers before closing
];

/** Tools that MUTATE the tree — the clock a review must beat. */
const EDIT_TOOLS: readonly string[] = [
  'capability:edit',
  'capability:write',
  'capability:multi_edit',
  'capability:multiedit',
];

const isOk = (row: SelfReviewLedgerRow): boolean =>
  row.status === undefined || row.status === 'ok';

const matches = (toolName: string, set: readonly string[]): boolean => {
  const name = toolName.trim();
  return set.some((t) => name === t || name.replaceAll(':', '_') === t.replaceAll(':', '_'));
};

/**
 * Whether this item is assigned to arm B, and so gated.
 *
 * ⚠ **Default MUST be false** (D-020). Arm A is the solo baseline and arm B is solo + this
 * gate; a gate that fires by default makes the two arms identical and the pilot can no longer
 * say what the gate is worth — it answers the question by making it unaskable. It would also
 * turn every in-flight close in the fleet into a refusal, on the one verb no agent can route
 * around. The pilot's assignment protocol (P-006) sets this marker; nothing else should.
 */
export function itemIsArmB(item: { payload?: unknown } | null | undefined): boolean {
  const payload = item?.payload;
  if (!payload || typeof payload !== 'object') return false;
  const arm = (payload as { pilotArm?: unknown }).pilotArm;
  return typeof arm === 'string' && arm.trim().toUpperCase() === 'B';
}

export function claimsSelfReview(evidence: SelfReviewEvidence | null | undefined): boolean {
  if (!evidence) return false;
  return Boolean(
    evidence.lookedAt?.trim() ||
      evidence.findings?.length ||
      evidence.changedAsResult?.length,
  );
}

/**
 * The last moment the tree was mutated, per the ledger. `undefined` when this scope never
 * edited anything — in which case there is no shipped state to have reviewed stale.
 */
export function lastEditAtMs(ledger: readonly SelfReviewLedgerRow[]): number | undefined {
  const edits = ledger.filter((r) => isOk(r) && matches(r.toolName, EDIT_TOOLS));
  return edits.length ? Math.max(...edits.map((r) => r.invokedAtMs)) : undefined;
}

/**
 * Judge a claimed self-review against the ledger.
 *
 * `ledger` MUST already be selected for this agent and this goal — see the harness-slug trap
 * in the module docstring. Passing an over-broad selection makes every verdict meaningless in
 * the permissive direction, which is why this takes rows rather than doing its own query.
 */
/**
 * The verdicts that REFUSE a close. Everything else — notably `rubberStampRisk` and
 * `yieldedChange` — is a pilot MEASUREMENT and must never block (D-020).
 *
 * Declared as data rather than an inline conditional so the rule is testable without a
 * database, and so a verdict added later fails a test instead of silently defaulting to
 * "allowed" at the one call site.
 */
export const SELF_REVIEW_REFUSING_VERDICTS: ReadonlySet<SelfReviewVerdict> = new Set([
  'not-claimed',
  'uncorroborated',
  'stale-review',
]);

/**
 * The refusal message for an arm-B close, or `undefined` to allow it.
 *
 * Extracted from the `work_items:complete` gate so the load-bearing rule — which verdicts
 * refuse — can be exercised directly. Inline at the call site it was reachable only through
 * a live ledger query, which is precisely how a gate ends up never being tested against the
 * case it was written to permit.
 */
export function selfReviewRefusal(
  judgement: SelfReviewJudgement,
  itemId: string,
): string | undefined {
  if (!SELF_REVIEW_REFUSING_VERDICTS.has(judgement.verdict)) return undefined;
  return (
    `REJECTED — ${itemId} is assigned to pilot arm B, which requires a corroborated ` +
    `self-review before it can close. Verdict: ${judgement.verdict}` +
    (judgement.reason ? ` — ${judgement.reason}` : '') +
    `. Re-read the diff as it now stands (capability:git / capability:read), then re-send ` +
    `the completion with completion.selfReview: { lookedAt: "<what you re-read>", ` +
    `findings: [...], changedAsResult: [...] }. An EMPTY findings array is accepted and ` +
    `recorded — do not invent findings.`
  );
}

export function judgeSelfReview(args: {
  evidence: SelfReviewEvidence | null | undefined;
  ledger: readonly SelfReviewLedgerRow[];
}): SelfReviewJudgement {
  const { evidence, ledger } = args;

  const findings = evidence?.findings ?? [];
  const changed = evidence?.changedAsResult ?? [];
  const yieldedChange = changed.length > 0;

  if (!claimsSelfReview(evidence)) {
    return {
      verdict: 'not-claimed',
      reviewCalls: [],
      rubberStampRisk: false,
      yieldedChange: false,
      reason: 'no self-review was recorded on this completion',
    };
  }

  const reviewCalls = ledger
    .filter((r) => isOk(r) && matches(r.toolName, REVIEW_TOOLS))
    .sort((a, b) => a.invokedAtMs - b.invokedAtMs);

  if (reviewCalls.length === 0) {
    return {
      verdict: 'uncorroborated',
      reviewCalls: [],
      rubberStampRisk: false,
      yieldedChange,
      reason:
        'a self-review was claimed but the invocation ledger records no read of the code ' +
        'for this work item — the claim rests on prose alone (D-002)',
    };
  }

  const lastEdit = lastEditAtMs(ledger);
  const latestReview = reviewCalls[reviewCalls.length - 1]!.invokedAtMs;

  // A review that predates the final edit reviewed a state that was then changed. The
  // transcript still contains a diff read, so this reads as compliant until it is checked.
  if (lastEdit !== undefined && latestReview < lastEdit) {
    return {
      verdict: 'stale-review',
      reviewCalls,
      rubberStampRisk: false,
      yieldedChange,
      reason:
        'the last recorded review predates the last edit, so the state being closed was ' +
        'never reviewed — re-read the diff as it now stands',
    };
  }

  return {
    verdict: 'corroborated',
    reviewCalls,
    rubberStampRisk: findings.length === 0,
    yieldedChange,
  };
}
