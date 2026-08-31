/**
 * rubric-loss-guard.ts — the WI-4287 rubric loss-guard RULE CORE, lifted to the shared
 * `template_data` PERSISTENCE BOUNDARY (EI-21972673091438558).
 *
 * A rubric is a plan row: its criteria live in `harness_plans.template_data`. TWO doors
 * write that column and, before this module, only ONE was guarded:
 *
 *   • `rubrics:propose` / `rubrics:amend` → proposeRubric, which calls
 *     assertNoSilentRubricLoss against a snapshot read OUTSIDE the advisory lock; and
 *   • `plans:set-template-data` → the generic structured-write verb, which validates
 *     STRUCTURE ONLY. A criteria array of length 1 satisfies the zod schema exactly as
 *     well as one of length 27, so a whole rubric could be silently gutted through it —
 *     including the portfolio-activity-floor criterion added THROUGH that same door.
 *
 * Bolting a second guard onto `set-template-data` would have left door three unguarded.
 * Instead the rule core lives here, pure, and is enforced where BOTH doors converge:
 * `withPlanLock`'s template_data write, INSIDE the advisory-locked transaction, against
 * the row actually being replaced. That placement also closes the propose path's
 * read-outside-the-lock window, where a concurrent writer's criterion could be dropped
 * by a proposal that was assembled before that criterion existed.
 *
 * Pure by construction: zod + the rubric template schema only, no DB, no imports from
 * rubrics.ts (which imports withPlanLock — the cycle this file exists to avoid).
 */

import { rubricTemplateDataSchema } from './rubric-template';

/** The marker string that tags an embedded replication drill in method/replication
 *  prose. Losing it from a criterion's combined procedure text is a guard violation. */
export const REPLICATION_DRILL_MARKER = 'REPLICATION DRILL';

/** A criterion's combined procedure text must not shrink below this fraction of the
 *  stored text (0.6 ⇒ a >40% shrink violates) without an explicit allowMethodShrink. */
export const METHOD_SHRINK_GUARD_RATIO = 0.6;

/** The shrink-ratio guard only applies when the STORED procedure text is at least this
 *  long — a 50-char method being reworded shouldn't trip a loss guard; a 4,600-char
 *  drill being gutted must. The MARKER guard applies regardless of length. */
export const METHOD_SHRINK_GUARD_MIN_CHARS = 200;

/**
 * The criterion fields the loss rules read — a deliberate WIDENING of the schema-owned
 * criterion type, not a second copy of it: both `Rubric['criteria']` (the v1 shape) and
 * `RubricTemplateData['criteria']` (the persisted shape) must remain assignable to it,
 * which the compiler re-checks at every call site.
 */
export interface RubricLossCriterion {
  key: string;
  method?: string;
  replication?: string;
  check?: { kind: string } | undefined;
  criterionClass?: string | undefined;
}

/**
 * The caller's EXPLICIT acknowledgements. A loss is only ever allowed when the caller
 * named it: dropped keys must be listed, a gutted procedure needs allowMethodShrink +
 * a written reason, a class downgrade needs its own reason. `plans:set-template-data`
 * has no such arguments and therefore passes NO ack — through that door a rubric write
 * may add and edit criteria but never lose one.
 */
export interface RubricLossAck {
  dropKeys?: string[];
  allowMethodShrink?: boolean;
  shrinkReason?: string;
  classDowngradeReason?: string;
}

/** A criterion's full procedure text: method + replication drill combined. Comparing
 *  the COMBINED text (D-002) means moving a drill between the two fields is never a
 *  violation — only genuine text loss is. */
export function criterionProcedureText(c: { method?: string; replication?: string }): string {
  return `${c.method ?? ''}${c.replication ? `\n${c.replication}` : ''}`;
}

/**
 * PURE RULE CORE: everything that counts as SILENT LOSS between a stored criteria array
 * and the one about to replace it, as human-readable violation strings (empty ⇒ clean).
 *
 * Callers turn these into their own errors: proposeRubric keeps its `invalid_args:`
 * caller-error phrasing, the persistence boundary points at the acking verb. Sharing
 * this one function is what keeps the two doors from drifting into two dialects of
 * "loss" — the failure this whole file exists to prevent.
 */
export function collectRubricLossViolations(
  storedCriteria: readonly RubricLossCriterion[],
  proposedCriteria: readonly RubricLossCriterion[],
  ack: RubricLossAck = {},
): string[] {
  const proposedByKey = new Map(proposedCriteria.map((c) => [c.key, c]));
  const acked = new Set(ack.dropKeys ?? []);
  const violations: string[] = [];

  // 1) dropped criteria — every stored key must survive or be explicitly acknowledged.
  const dropped = storedCriteria.filter((c) => !proposedByKey.has(c.key) && !acked.has(c.key));
  if (dropped.length > 0) {
    violations.push(
      `DROPS ${dropped.length} stored criteri${dropped.length === 1 ? 'on' : 'a'}: ${dropped
        .map((c) => `'${c.key}'`)
        .join(', ')} — acknowledge intentional removal with dropKeys:[${dropped
        .map((c) => `"${c.key}"`)
        .join(', ')}], or rubrics:get the stored rubric and resubmit ALL criteria (a partial list silently deletes the rest)`,
    );
  }

  // 2) procedure loss on surviving criteria — marker loss or a sharp combined shrink.
  const shrinkViolations: string[] = [];
  for (const storedCrit of storedCriteria) {
    const proposed = proposedByKey.get(storedCrit.key);
    if (!proposed) continue; // handled by the drop guard above
    const before = criterionProcedureText(storedCrit);
    const after = criterionProcedureText(proposed);
    if (before.includes(REPLICATION_DRILL_MARKER) && !after.includes(REPLICATION_DRILL_MARKER)) {
      shrinkViolations.push(
        `criterion '${storedCrit.key}' LOSES its '${REPLICATION_DRILL_MARKER}' testing procedure (stored method+replication carries the marker; the proposal's doesn't)`,
      );
    } else if (
      before.length >= METHOD_SHRINK_GUARD_MIN_CHARS &&
      after.length < before.length * METHOD_SHRINK_GUARD_RATIO
    ) {
      const pct = Math.round((1 - after.length / before.length) * 100);
      shrinkViolations.push(
        `criterion '${storedCrit.key}' procedure text (method+replication) shrinks ${before.length} → ${after.length} chars (−${pct}%)`,
      );
    }
  }

  // 2b) structured-check loss (P-011 / D-006) — a stored criterion's deterministic
  //    `check` resubmitted absent silently converts a machine-enforced criterion back
  //    to fuzzy judgment: the same silent-weakening family as a procedure shrink, so it
  //    rides the same allowMethodShrink + shrinkReason ack (a check IS procedure, in
  //    structured form). Changing a check's content (different files / different
  //    instrument) is a visible edit, not a silent loss — only total removal is guarded.
  const checkLosses = storedCriteria.filter((c) => {
    if (!c.check) return false;
    const proposed = proposedByKey.get(c.key);
    return proposed !== undefined && proposed.check === undefined;
  });
  if (checkLosses.length > 0) {
    shrinkViolations.push(
      ...checkLosses.map(
        (c) =>
          `criterion '${c.key}' LOSES its structured ${c.check!.kind} check (deterministic enforcement reverts to fuzzy judgment)`,
      ),
    );
  }

  // 3) criterion-class weakening (P-008) — a stored 'violatable' criterion resubmitted
  //    without the class (or downgraded to settle-once) silently removes its
  //    provisional-until-terminal protection, the same silent-weakening family as a
  //    procedure shrink. Upgrades (settle-once → violatable) are never guarded.
  const downgraded = storedCriteria.filter((c) => {
    if (c.criterionClass !== 'violatable') return false;
    const proposed = proposedByKey.get(c.key);
    return proposed !== undefined && proposed.criterionClass !== 'violatable';
  });
  if (downgraded.length > 0 && (ack.classDowngradeReason ?? '').trim() === '') {
    violations.push(
      `DOWNGRADES ${downgraded.length} 'violatable' criteri${downgraded.length === 1 ? 'on' : 'a'} to settle-once: ${downgraded
        .map((c) => `'${c.key}'`)
        .join(', ')} — mid-run ratings of these would stop being stamped provisional. If intentional, pass a non-empty classDowngradeReason; otherwise resubmit them with criterionClass:'violatable'`,
    );
  }

  if (shrinkViolations.length > 0) {
    if (ack.allowMethodShrink && (ack.shrinkReason ?? '').trim() !== '') {
      // conscious, explained shrink — allowed.
    } else if (ack.allowMethodShrink) {
      violations.push(
        `${shrinkViolations.join('; ')} — allowMethodShrink is set but shrinkReason is empty: explain WHY the procedure is intentionally shrinking`,
      );
    } else {
      violations.push(
        `${shrinkViolations.join('; ')} — if intentional, pass allowMethodShrink:true + shrinkReason; otherwise restore the full procedure text (rubrics:get the stored rubric and edit from it)`,
      );
    }
  }

  return violations;
}

/**
 * Read the guardable criteria out of a stored/incoming `template_data` value.
 *
 * `null`/`undefined` data is NOT "no criteria to compare" on the incoming side — it is a
 * CLEAR of the column, which erases every stored criterion at once. It is reported as an
 * empty criteria array so the drop rule catches it; the stored side treats it as "nothing
 * was there yet", which is the brand-new-rubric case the guard must let through.
 *
 * A value that fails the rubric schema is reported as `null` (unguardable): on the stored
 * side that is a wedged placeholder with nothing to lose, and on the incoming side the
 * registry validation that runs before this point is what refuses it.
 */
function guardableCriteria(
  data: unknown,
  side: 'stored' | 'incoming',
): readonly RubricLossCriterion[] | null {
  if (data === null || data === undefined) return side === 'incoming' ? [] : null;
  const parsed = rubricTemplateDataSchema.safeParse(data);
  if (!parsed.success) return null;
  return parsed.data.criteria;
}

/**
 * THE BOUNDARY GUARD: refuse a `template_data` write that would silently lose criteria
 * or their testing procedures from a rubric-template plan. Throws a teaching error naming
 * exactly what would be lost; returns silently when the write is clean, when the plan is
 * not a rubric, or when there is no parseable stored rubric to lose anything from.
 *
 * `ack` is the ONLY way past a real loss, and only `rubrics:propose`/`amend` supply one —
 * they collect it from the caller as explicit arguments and have already reported it.
 */
export function assertNoSilentRubricTemplateDataLoss(args: {
  slug: string;
  storedTemplateData: unknown;
  nextTemplateData: unknown;
  ack?: RubricLossAck;
}): void {
  const stored = guardableCriteria(args.storedTemplateData, 'stored');
  if (stored === null || stored.length === 0) return;
  const next = guardableCriteria(args.nextTemplateData, 'incoming');
  if (next === null) return;

  const violations = collectRubricLossViolations(stored, next, args.ack ?? {});
  if (violations.length === 0) return;

  // `invalid_args:` so the tool-error classifier buckets this as a CALLER error (the
  // write's own arguments would lose stored content), not a structural tool bug that the
  // improvement-watchdog would file into the auto-implement lane (EI-10148).
  throw new Error(
    `invalid_args: rubric '${args.slug}': this template_data write would SILENTLY LOSE stored rubric content:\n` +
      violations.map((v) => `  • ${v}`).join('\n') +
      `\nA rubric's criteria are guarded at the persistence boundary, so EVERY door writing ` +
      `template_data on a rubric plan is subject to this check. plans:set-template-data has no ` +
      `acknowledgement arguments by design: resubmit the FULL criteria array (plans:get-template-data ` +
      `returns the stored one), or make the removal through rubrics:propose / rubrics:amend, which ` +
      `take dropKeys / allowMethodShrink + shrinkReason / classDowngradeReason.`,
  );
}
