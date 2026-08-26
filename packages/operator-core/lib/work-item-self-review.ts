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
 * `session_turn_parts` is CORPUS-namespaced, not tenant-namespaced: every one of its
 * 2,373,429 rows carries `workspace_id = 'default'` (measured). Pinning it to the item's
 * workspace instead would return a clean zero — the same false-absence shape as the
 * harness-slug trap below, one table over.
 */
export const SESSION_TURN_PARTS_WORKSPACE_ID = 'default';

/**
 * The ledger selection, as SQL text + values. Exported as data rather than executed here so
 * the predicate itself is testable and so the traps below live at ONE reviewable seam.
 *
 * ## Two ledgers, because neither one sees every agent
 *
 * `tool_invocations` records **MCP tools only** — native client tools (Read, Grep, Edit,
 * Write) never appear in it. So an agent that reviewed its diff with native `Read` produced
 * zero rows and was refused, while an otherwise identical agent that routed the same read
 * through `capability:read` passed (EI-21481919801123128). That is not a uniform failure,
 * which would at least be visible: it split the arm-B population by TOOL HABIT, silently
 * confounding the pilot's central variable. `session_turn_parts` records the native calls,
 * so corroboration reads both and normalizes across their three naming schemes
 * (`capability:read`, `mcp__papercusp-su__capability_read`, `Read` — see `normalizeToolName`).
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
 * ⚠ **The turn-parts leg has NO goal_ref at all** — the table does not carry one — so it is
 * scoped by owner + window only. That is strictly more permissive than the invocations leg,
 * in the same direction and for the same reason as the `goal_ref IS NULL` admission above.
 *
 * The direction of those choices is the point: being slightly permissive risks crediting a
 * review performed for a neighbouring item, while being strict risks REFUSING an honest close
 * on the fleet's hot path and corrupting the pilot arm with false refusals. For an
 * experimental gate the second failure is far worse than the first, so this errs permissive
 * and records `rubberStampRisk` / `yieldedChange` to keep the arm measurable regardless.
 *
 * ⚠ **The turn-parts leg depends on migration 968** — a partial index on `(owner, ts)` where
 * `part_kind = 'tool_use'`. Without it this is a 2.4M-row parallel seq scan (measured: 444ms,
 * 222,576 buffers, 5 workers) on the `work_items:complete` hot path. The `part_kind` literal
 * below is what lets the planner use that partial index; do not relax it to an `IN (...)`.
 */
export function selfReviewLedgerQuery(args: {
  workspaceId: string;
  coordOwnerId: string;
  goalRef: string;
  sinceMs: number;
}): { text: string; values: unknown[] } {
  return {
    text: `SELECT tool_name, invoked_at, status, 'invocations' AS source
             FROM harness_shared.tool_invocations
            WHERE workspace_id = $1
              AND coord_owner_id = $2
              AND (goal_ref = $3 OR goal_ref IS NULL)
              AND invoked_at >= $4
            UNION ALL
           SELECT tool_name, ts AS invoked_at, NULL AS status, 'turn-parts' AS source
             FROM harness_shared.session_turn_parts
            WHERE workspace_id = '${SESSION_TURN_PARTS_WORKSPACE_ID}'
              AND owner = $2
              AND part_kind = 'tool_use'
              AND tool_name IS NOT NULL
              AND ts >= $4
            ORDER BY invoked_at ASC`,
    values: [args.workspaceId, args.coordOwnerId, args.goalRef, new Date(args.sinceMs)],
  };
}

/** Narrow a raw ledger row to the shape the verdict depends on. */
export function toSelfReviewLedgerRow(raw: {
  tool_name?: unknown;
  invoked_at?: unknown;
  status?: unknown;
  source?: unknown;
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
    source: raw.source === 'turn-parts' || raw.source === 'invocations' ? raw.source : undefined,
  };
}

/** A ledger row, narrowed to what a review verdict actually depends on. */
export interface SelfReviewLedgerRow {
  readonly toolName: string;
  readonly invokedAtMs: number;
  /**
   * `status` from the ledger; a refused/errored call never counts as having reviewed.
   *
   * ⚠ Always `undefined` on a `turn-parts` row: that table records the CALL, and the result
   * arrives as a separate part, so a native call that errored still counts as a review. This
   * is a known permissive edge, in the same direction as the scoping choices above.
   */
  readonly status?: string;
  /**
   * Which ledger produced this row. Carried so the pilot can report how arm B's corroboration
   * was actually obtained, and so the cross-source dedup below has something to key on.
   */
  readonly source?: 'invocations' | 'turn-parts';
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
  | 'not-claimed'
  /**
   * Neither ledger recorded ANY call by this agent in this window — so the instrument is
   * blind, and "no review was found" carries no information. Distinct from `uncorroborated`,
   * which means we could see this agent's calls and none of them was a review.
   *
   * This is self-falsifying rather than a courtesy: reaching `work_items:complete` at all
   * requires having made at least one tool call in the window, so a totally empty ledger is
   * POSITIVE evidence of blindness, not evidence of inactivity. Refusing on it would mean an
   * ingestion outage silently converting arm B into a wall on the fleet's one unroutable
   * verb. Non-refusing, and recorded so the pilot can report how often it fired.
   */
  | 'unobservable';

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
  /**
   * Whether either ledger could see this agent at all in the window. False is what separates
   * `unobservable` from `uncorroborated`, and it is a pilot measurement in its own right: a
   * rising rate here means arm B is being judged on an instrument that cannot see its
   * subjects.
   */
  readonly ledgerVisible: boolean;
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
  // Native client equivalents. Without these the gate could only see agents who happened to
  // route their reads through MCP — see the two-ledger note on `selfReviewLedgerQuery`.
  'Read',
  'Grep',
  'Glob',
];

/**
 * Tools that MUTATE the tree — the clock a review must beat.
 *
 * ⚠ The native names here are NOT optional garnish. Widening REVIEW_TOOLS to native tools
 * while leaving this list MCP-only would be worse than the bug it fixes: a native-editing
 * agent would have no recorded edits, `lastEditAtMs` would be `undefined`, and the
 * stale-review check could never fire for exactly the agents newly able to pass. Arm B would
 * then corroborate reviews of states that were subsequently rewritten.
 */
const EDIT_TOOLS: readonly string[] = [
  'capability:edit',
  'capability:write',
  'capability:multi_edit',
  'capability:multiedit',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
];

/**
 * `Bash` is deliberately in NEITHER list.
 *
 * It is the single highest-volume native tool (measured: 124 calls to 19 `Read`s in one
 * session), and it is arbitrary: `git diff` is a review, `npm test` is not, `ls` is neither.
 * Admitting the class would let routine traffic corroborate a review nobody performed —
 * the failure the module docstring calls worse than having no gate at all, because it
 * MANUFACTURES evidence rather than merely missing it. Admitting it to EDIT_TOOLS would be
 * the mirror defect: any `Bash` after a review would read as a subsequent edit and turn
 * honest closes into `stale-review`. Discriminating by parsing the command text out of the
 * part payload was considered and rejected — a shell-command regex on the completion hot
 * path fails in both directions and is untestable in the way that matters.
 *
 * The practical cost is bounded: an agent that genuinely re-reads code essentially always
 * `Read`s something, and `selfReviewRefusal` names the qualifying tools so an agent refused
 * on a Bash-only review can comply with one call.
 */
const AMBIGUOUS_NATIVE_TOOLS: readonly string[] = ['Bash'];

const isOk = (row: SelfReviewLedgerRow): boolean =>
  row.status === undefined || row.status === 'ok';

/**
 * Collapse the THREE names the same tool wears across the two ledgers into one key.
 *
 * `tool_invocations` stores `capability:read`. `session_turn_parts` stores the
 * CLIENT-MANGLED `mcp__papercusp-su__capability_read` for that identical call, and a bare
 * `Read` for the native one. Comparing raw strings — or the previous `:`→`_` swap alone —
 * matches none of the mangled forms, which is how a widened tool list could look correct
 * and still corroborate nothing.
 */
export function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .replace(/^mcp__.+?__/, '') // mcp__papercusp-su__capability_read → capability_read
    .replaceAll(':', '_')
    .toLowerCase();
}

const matches = (toolName: string, set: readonly string[]): boolean => {
  const name = normalizeToolName(toolName);
  return set.some((t) => name === normalizeToolName(t));
};

/** True when the row is a tool whose class we deliberately refuse to judge either way. */
const isAmbiguous = (row: SelfReviewLedgerRow): boolean =>
  matches(row.toolName, AMBIGUOUS_NATIVE_TOOLS);

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
    `. Re-read the diff as it now stands — Read / Grep, or capability:git / capability:read; ` +
    `a shell command does NOT corroborate, because it cannot be told apart from routine ` +
    `traffic — then re-send the completion with completion.selfReview: { lookedAt: "<what you re-read>", ` +
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

  // Whether the instrument can see this agent AT ALL. Computed before any tool filtering,
  // because that is exactly what distinguishes "no review happened" from "we are blind".
  const ledgerVisible = ledger.length > 0;

  if (!claimsSelfReview(evidence)) {
    // Refuses regardless of visibility: this is the agent declining to record a review, which
    // needs no ledger to establish.
    return {
      verdict: 'not-claimed',
      reviewCalls: [],
      rubberStampRisk: false,
      yieldedChange: false,
      ledgerVisible,
      reason: 'no self-review was recorded on this completion',
    };
  }

  const reviewCalls = dedupeAcrossSources(
    ledger.filter((r) => isOk(r) && matches(r.toolName, REVIEW_TOOLS)),
  );

  if (reviewCalls.length === 0) {
    if (!ledgerVisible) {
      return {
        verdict: 'unobservable',
        reviewCalls: [],
        rubberStampRisk: false,
        yieldedChange,
        ledgerVisible,
        reason:
          'neither the invocation ledger nor the session transcript recorded ANY call by ' +
          'this agent in this window, so the absence of a review is not evidence that none ' +
          'happened — the gate is blind here and does not refuse on it',
      };
    }
    // Reachable only with `reviewCalls` empty, so "saw a shell command" and "the ONLY
    // code-adjacent calls were shell commands" coincide here — named for the latter, which
    // is what the reason it selects actually asserts.
    const sawOnlyShellCommands = ledger.some((r) => isOk(r) && isAmbiguous(r));
    return {
      verdict: 'uncorroborated',
      reviewCalls: [],
      rubberStampRisk: false,
      yieldedChange,
      ledgerVisible,
      reason: sawOnlyShellCommands
        ? 'a self-review was claimed and this agent WAS active, but the only code-adjacent ' +
          'calls recorded are shell commands, which cannot be told apart from routine ' +
          'traffic — re-read a changed file with Read or capability:read (D-002)'
        : 'a self-review was claimed but neither ledger records a read of the code for this ' +
          'work item — the claim rests on prose alone (D-002)',
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
      ledgerVisible,
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
    ledgerVisible,
  };
}

/**
 * The judgement as it is STORED on a completed item — the arm-B pilot's actual data.
 *
 * WI-41769: before this existed the judgement was computed and thrown away (passed inline
 * into `selfReviewRefusal` and never bound), so `rubberStampRisk` and `yieldedChange` —
 * both documented as pilot MEASUREMENTS — reached no store and D-022's per-arm comparison
 * had nothing to read. Note the asymmetry that hid it: the REFUSAL path is fully observable
 * because the agent sees the message, so the gate looked like it was working. It is the
 * PASSING path, the one that generates the pilot's data, that recorded nothing.
 *
 * Deliberately NOT the full `SelfReviewJudgement`: the raw `reviewCalls` rows are ledger
 * detail that would bloat every completed row without answering a question D-022 asks. The
 * COUNT and the SOURCES are kept, because D-026 established that HOW corroboration was
 * obtained is itself a confound the pilot must be able to see — an arm whose passes come
 * entirely from one ledger is measuring tool routing again.
 */
export interface PersistedSelfReviewJudgement {
  readonly verdict: SelfReviewVerdict;
  readonly rubberStampRisk: boolean;
  readonly yieldedChange: boolean;
  readonly ledgerVisible: boolean;
  readonly reviewCallCount: number;
  /** Which ledgers corroborated, deduped and sorted. Absent when nothing corroborated. */
  readonly reviewSources?: readonly ('invocations' | 'turn-parts')[];
}

/** Project a judgement onto the shape stored with the completion. */
export function toPersistedSelfReviewJudgement(
  judgement: SelfReviewJudgement,
): PersistedSelfReviewJudgement {
  const sources = [
    ...new Set(
      judgement.reviewCalls
        .map((r) => r.source)
        .filter((s): s is 'invocations' | 'turn-parts' => s !== undefined),
    ),
  ].sort();
  return {
    verdict: judgement.verdict,
    rubberStampRisk: judgement.rubberStampRisk,
    yieldedChange: judgement.yieldedChange,
    ledgerVisible: judgement.ledgerVisible,
    reviewCallCount: judgement.reviewCalls.length,
    ...(sources.length ? { reviewSources: sources } : {}),
  };
}

/**
 * One MCP call lands in BOTH ledgers — as `capability:read` and as
 * `mcp__papercusp-su__capability_read` — so a naive union double-counts every review an
 * MCP-routing agent performs. The verdict would survive that, but `reviewCalls` is recorded
 * on the completion and read as a pilot measurement, and an arm whose review-count metric
 * silently doubles for one half of its population is measuring tool routing again.
 *
 * Keyed on normalized name + whole second: the two tables timestamp the same call from
 * different clocks, so they agree to within well under a second but rarely to the millisecond.
 * Sorted ascending, since `judgeSelfReview` takes the last element as the latest review.
 */
function dedupeAcrossSources(rows: readonly SelfReviewLedgerRow[]): SelfReviewLedgerRow[] {
  const seen = new Map<string, SelfReviewLedgerRow>();
  for (const row of rows) {
    const key = `${normalizeToolName(row.toolName)}@${Math.floor(row.invokedAtMs / 1000)}`;
    // Prefer the invocations row: it is the only one carrying a real `status`.
    const existing = seen.get(key);
    if (!existing || (existing.source === 'turn-parts' && row.source === 'invocations')) {
      seen.set(key, row);
    }
  }
  return [...seen.values()].sort((a, b) => a.invokedAtMs - b.invokedAtMs);
}
