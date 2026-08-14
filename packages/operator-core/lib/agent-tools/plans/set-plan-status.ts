/**
 * plans:set-plan-status — flip a plan's PLAN-LEVEL frontmatter status,
 * the lifecycle gate the /adv Plans tab surfaces as buckets:
 *
 *   draft → ready      (approve — unlocks Start; does NOT start the plan)
 *   ready → draft      (demote — reverse approval)
 *   any  → shipped     (ship)
 *   any  → superseded  (reject)
 *
 * The agent-facing counterpart of the UI's approve / demote / reject
 * affordances — gives scoper/operator/etc. parity with the buttons in
 * PlanActions. Surgical edit of the frontmatter `status:` line only;
 * body + every other frontmatter key preserved verbatim. Writes inside
 * the SU lock, auto-bumps `updated:`, captures a plan revision, and
 * emits a `status_changed` plan-event.
 *
 * NOT for item (P-NNN) status — that's plans:set-status. NOT for legacy
 * plans without frontmatter — convert with plans:set-frontmatter first.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug, resolveEffectiveHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { clearStartedForTerminalPlan, isTerminalPlanStatus } from './plan-start-state';
import { stampTerminalNowBlock } from './terminal-now-stamp';
import { stampForcedPastWaiver } from './forced-past-stamp';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitDeprecateLearnings, type DeprecateLearnings } from '../../harness/improvements/deprecate-learnings';
import { ObservationEvidenceError } from '../../harness/improvements/observation-types';
import { evaluatePlanAcceptanceGate } from '../../plan-acceptance-gate';
import { launchAcceptanceGrader, type AcceptanceGraderLifecycle } from '../../acceptance-grader';
import { evaluateScoutRatificationGate } from '../../scout/ratification-gate';
import { retireAcceptanceRubricForPlan } from '../../rubrics';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

/** Canonical settable plan-level lifecycle targets — what we WRITE. */
const SETTABLE = ['draft', 'ready', 'shipped', 'superseded'] as const;
/** Statuses a caller may guard on via `expectedCurrent` — the full set,
 *  since existing plans can still carry the legacy `active`. */
const GUARDABLE = ['draft', 'ready', 'active', 'shipped', 'superseded'] as const;
/** Caller-DX (watchdog P-006): aliases agents reach for, mapped to the
 *  canonical settable status instead of being zod-rejected. `active` is the
 *  legacy synonym for `ready` (bucketOf treats it as approved). `done` is the
 *  ITEM-status word — at PLAN level a "done" plan is `shipped`. Accept + map
 *  (echo `mappedFrom`) so the confusing reject (vs plans:set-status) stops
 *  recurring. */
const STATUS_ALIASES: Record<string, (typeof SETTABLE)[number]> = {
  active: 'ready',
  done: 'shipped',
};
/** Accepted on the wire = canonical + the mapped aliases. */
const ACCEPTED = ['draft', 'ready', 'shipped', 'superseded', 'active', 'done'] as const;

/** Pure (watchdog P-006): map an accepted status to its canonical settable form,
 *  reporting the alias that was mapped (for the `mappedFrom` echo). */
export function normalizePlanStatus(status: string): { status: string; mappedFrom?: string } {
  const mapped = STATUS_ALIASES[status];
  return mapped ? { status: mapped, mappedFrom: status } : { status };
}

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional(),
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(200)
      .optional()
      .describe('Plan slugs to move to the same lifecycle status in one call.'),
    status: z
      .enum(ACCEPTED)
      .describe(
        "Target plan-level status. Canonical: draft | ready | shipped | superseded. Aliases accepted + mapped: 'active'→ready, 'done'→shipped (the item-status words agents reach for). For a P-NNN item's status use plans:set-status instead.",
      ),
    expectedCurrent: z
      .enum(GUARDABLE)
      .optional()
      .describe(
        'Optional transition guard — only flip if the current status matches. e.g. approve passes `draft` so it never overwrites an already-shipped plan.',
      ),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional note on why the lifecycle moved. Stored on the plan revision (D-009), not in the frontmatter.',
      ),
    // ── queen-scout-feedback-loop-2026-06-20 P-006 / B10: the DEPRECATE path.
    learnings: z
      .object({
        tried: z.string().min(1).describe('what approach / premise was attempted on the draft'),
        stalled: z.string().min(1).describe("why it stalled — the reason it won't reach ready"),
        salvageable: z
          .string()
          .min(1)
          .describe("what's salvageable — the reusable signal a future Blender cycle can re-ideate from"),
      })
      .optional()
      .describe(
        "ONLY honored on status='superseded' (a DEPRECATE): the free-text learnings (what was tried / why it stalled / what's salvageable). Providing it makes the deprecate ALSO emit a structured, source-tagged 'learnings' observation into the observation lane, so a dead draft still feeds Scout's corpus-digest (queen-scout-feedback-loop P-006 — 'no dead ends'). Omit on a plain reject.",
      ),
    sourceHive: z
      .string()
      .max(120)
      .optional()
      .describe(
        "deprecate-learnings only: the observation's source hive (the hive the draft belonged to). Defaults to the plan's harness.",
      ),
    evidence: z
      .array(z.string().max(200))
      .max(12)
      .optional()
      .describe('deprecate-learnings only: refs grounding the learnings (the deprecated plan ref is always included).'),
    // The acceptance gate has implemented `force` since D-003 and EVERY one of its
    // refusals tells the caller to "pass force:{ reason }" — but the key was never
    // declared here and never threaded to evaluatePlanAcceptanceGate, so the schema
    // rejected it as an unrecognized key. The advertised escape hatch did not exist,
    // which is half of EI-20430092702151575: a plan that could not satisfy the gate
    // could not force past it either, and so could not ship at all.
    force: z
      .object({ reason: z.string().min(1).max(2000) })
      .optional()
      .describe(
        "status='shipped' only: ship past the acceptance gate's code-truth checks, recording the reason on the plan (`forcedPast`). A waived ship is deliberately loud, never silent. Does NOT waive the independently-flagged checks the gate marks non-waivable.",
      ),
  })
  .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
    message: 'pass `slug` or `slugs`',
  });

type SetPlanStatusValue =
  | {
      ok: true;
      oldStatus: string | null;
      newStatus: string;
      changed: boolean;
      nowStamped?: boolean;
      /** True when this write appended a forced-ship waiver — see forced-past-stamp.ts. */
      forcedPastStamped?: boolean;
    }
  | { ok: false; code: 'not_found' | 'no_status_line' | 'unexpected_status'; current?: string | null };

/** Frontmatter `status:` line, captured value in group 2, trailing ws in group 3. */
const STATUS_LINE_RE = /^(status:[ \t]*)([A-Za-z][\w-]*)([ \t]*)$/m;

/**
 * Pure decision function — flip the frontmatter `status:` line within
 * the leading `---`…`---` block only. Exported for unit testing
 * (mirrors `flipStatusInBody` in set-status.ts).
 *
 * Returns `newBody: null` with a `code` when nothing should be written:
 *   - no_status_line   — missing/legacy frontmatter, or no `status:` key
 *   - unexpected_status — `expectedCurrent` given and didn't match
 *   - noop             — already at the target (success, no write)
 */
export function flipPlanFrontmatterStatus(
  body: string,
  target: string,
  expectedCurrent?: string,
): { newBody: string | null; oldStatus: string | null; code?: 'no_status_line' | 'unexpected_status' | 'noop' } {
  if (!body.startsWith('---')) return { newBody: null, oldStatus: null, code: 'no_status_line' };
  const close = body.indexOf('\n---', 3);
  if (close === -1) return { newBody: null, oldStatus: null, code: 'no_status_line' };
  const fm = body.slice(0, close);
  const rest = body.slice(close);
  const m = STATUS_LINE_RE.exec(fm);
  if (!m) return { newBody: null, oldStatus: null, code: 'no_status_line' };
  const oldStatus = m[2] ?? null;
  if (expectedCurrent && oldStatus !== expectedCurrent) {
    return { newBody: null, oldStatus, code: 'unexpected_status' };
  }
  if (oldStatus === target) {
    return { newBody: null, oldStatus, code: 'noop' };
  }
  // String replacement: `target` is an enum value (no `$` substitution
  // sequences), trailing whitespace ($3) preserved.
  const newFm = fm.replace(STATUS_LINE_RE, `$1${target}$3`);
  return { newBody: newFm + rest, oldStatus };
}

/**
 * Apply a plan-level lifecycle target and the terminal-Now invariant as one
 * pure mutation. Unlike {@link flipPlanFrontmatterStatus}, an already-terminal
 * target is not necessarily a no-op: it repairs an unstamped `## Now` block.
 * That makes the existing bulk status verb a safe, idempotent backfill path.
 */
export function applyPlanStatusBody(
  body: string,
  target: string,
  expectedCurrent?: string,
  today: Date = new Date(),
): {
  newBody: string | null;
  oldStatus: string | null;
  code?: 'no_status_line' | 'unexpected_status' | 'noop';
  changed: boolean;
  nowStamped: boolean;
} {
  const flip = flipPlanFrontmatterStatus(body, target, expectedCurrent);
  if (flip.code === 'no_status_line' || flip.code === 'unexpected_status') {
    return { ...flip, changed: false, nowStamped: false };
  }

  const statusChanged = flip.code !== 'noop';
  const candidate = flip.newBody ?? body;
  const stamped = stampTerminalNowBlock(candidate, target, today);
  if (!statusChanged && stamped === null) {
    return { ...flip, changed: false, nowStamped: false };
  }
  return {
    newBody: stamped ?? flip.newBody,
    oldStatus: flip.oldStatus,
    changed: statusChanged,
    nowStamped: stamped !== null,
  };
}

/**
 * WI-38047 / D-015: best-effort caller ownerId for the no-self-ratification guard.
 * `resolveAgentIdentity` THROWS on an unattributable ctx — the guard then FAILS OPEN
 * (null ownerId ⇒ no originator comparison), which is exactly the rule D-012 set for
 * the sibling self-grade guard: an unattributed caller cannot be a PROVEN
 * self-ratification, and an attribution miss must never block a legitimate
 * cross-author approval. Elsewhere in this file identity is resolved unguarded, on
 * paths that already ran the write; this one runs BEFORE it and must not throw there.
 */
function resolveRatifierOwnerId(ctx: unknown): string | null {
  try {
    return resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
  } catch {
    return null;
  }
}

const ACCEPTANCE_GRADER_GATE_CODES = new Set(['acceptance_ungraded', 'self_graded_only']);

/** D-006: a grading refusal launches one fresh, dedicated judge. Keeping this
 * decision in a small exported seam makes the trigger independently testable and
 * prevents unrelated acceptance failures from spawning agents. */
export async function launchAcceptanceGraderForGate(
  slug: string,
  gate: { satisfied: boolean; code?: string },
  ctx: Parameters<typeof launchAcceptanceGrader>[1],
  launch: typeof launchAcceptanceGrader = launchAcceptanceGrader,
): Promise<AcceptanceGraderLifecycle | undefined> {
  if (gate.satisfied || !gate.code || !ACCEPTANCE_GRADER_GATE_CODES.has(gate.code)) return undefined;
  return launch(slug, ctx);
}

export default defineTool({
  name: 'plans:set-plan-status',
  description:
    "Flip a plan's lifecycle status (draft→ready approve, ready→draft demote, →shipped = mark COMPLETE/FINISHED/archive it, →superseded reject). Plan-level frontmatter, not an item's status. Also the Mug↔Scout DEPRECATE handler: pass `learnings` with status='superseded' to also emit a salvage observation into Scout's digest (no dead ends) — see guidance.",
  guidance: {
    when: "Moving a whole plan through its lifecycle: approving a reviewed draft (draft→ready, which unlocks Start), demoting an approved plan back to draft, marking it COMPLETE/FINISHED/DONE once every item is done (status='shipped' — archives it), or rejecting it (→superseded). DEPRECATING a Mug↔Blender draft that won't reach ready: status='superseded' + `learnings:{tried,stalled,salvageable}` — one atomic call deprecates AND records the salvage observation (don't file a separate improvements:capture).",
    notWhen:
      "Flipping a P-NNN item's status — use plans:set-status. Legacy plan without frontmatter — plans:set-frontmatter first (refused with no_status_line). `learnings` on a non-superseded status is ignored (deprecate-only). ⚠ 'shipped' refuses without a peer-graded acceptance rubric.",
    chaining:
      "plans:get (read current status) → plans:set-plan-status { slug, status: 'ready', expectedCurrent: 'draft' } to approve. Approving is optional before plans:start — starting a draft auto-approves it (draft→ready). Deprecate: plans:set-plan-status { slug, status:'superseded', learnings:{…} } → the returned learningsObservation reports the emitted observation.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    // Caller-DX (P-006): map a friendly alias (active→ready, done→shipped) to canonical.
    const { status, mappedFrom } = normalizePlanStatus(args.status);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        // Completion gate (acceptance-rubrics-on-every-plan-2026-08-11 P-004/P-005):
        // shipping requires a graded acceptance rubric — the refusal message IS the
        // authoring nudge (author it post-implementation, D-007; grader ≠ implementer,
        // D-005). Flag ACCEPTANCE_RUBRIC_COMPLETION_GATE (default ON); rubric-template
        // plans + scheduled template instances are exempt inside the gate.
        // Hoisted out of the `shipped` branch: the gate decides the waiver, but
        // the WRITE below is what makes it permanent, so the record has to
        // survive the branch that produced it.
        let forcedPast: { reason: string; checks: readonly string[] } | undefined;
        if (status === 'shipped') {
          const gate = await evaluatePlanAcceptanceGate(slug, args.force ? { force: args.force } : undefined);
          forcedPast = gate.forcedPast;
          if (!gate.satisfied) {
            const acceptanceGrader = await launchAcceptanceGraderForGate(slug, gate, ctx);
            return {
              ok: false as const,
              slug,
              error: gate.code ?? 'acceptance_gate_failed',
              message: gate.message,
              ...(gate.rubricId ? { rubricId: gate.rubricId } : {}),
              ...(acceptanceGrader ? { acceptanceGrader } : {}),
            };
          }
        }
        // Ratification gate (blender-su-grade-integration-2026-08-11 D-015, WI-38047):
        // a `ready` flip IS the approval on the scout rail — ready-plan-autostart
        // promotes the draft's items straight into the claimable pool with no second
        // gate — so a steward may never ratify a draft whose idea it filed itself.
        // Mirrors blender:grade-idea's no-self-grade refusal (D-012), including its
        // fail-open-on-unattributable rule. Silent for non-scout plans.
        if (status === 'ready') {
          const gate = await evaluateScoutRatificationGate({
            planSlug: slug,
            callerOwnerId: resolveRatifierOwnerId(ctx),
          });
          if (!gate.satisfied) {
            return {
              ok: false as const,
              slug,
              error: gate.code ?? 'ratification_gate_failed',
              message: gate.message,
              ...(gate.ideaId ? { ideaId: gate.ideaId } : {}),
            };
          }
        }
        const rev = planRevisionCapture(
          ctx as PlanRevisionCtx,
          slug,
          args.rationale,
          harnessSlug ? { harnessSlug } : {},
        );
        const result = await withPlanLock<SetPlanStatusValue>(
          ctx as never,
          {
            slug,
            intent: `plans:set-plan-status → ${status}`,
            ...(harnessSlug ? { harnessSlug } : {}),
            afterWrite: rev.afterWrite,
          },
          async (current): Promise<{ newBody: string | null; value: SetPlanStatusValue }> => {
            if (current === null) {
              return { newBody: null, value: { ok: false, code: 'not_found' } };
            }
            const mutation = applyPlanStatusBody(current, status, args.expectedCurrent);
            if (mutation.code === 'no_status_line') {
              return { newBody: null, value: { ok: false, code: 'no_status_line' } };
            }
            if (mutation.code === 'unexpected_status') {
              return {
                newBody: null,
                value: { ok: false, code: 'unexpected_status', current: mutation.oldStatus },
              };
            }
            // A forced ship records its waiver in this SAME locked write, so a
            // plan can never be observed as shipped-clean when it was shipped
            // forced — the gate's `forcedPast` contract ("permanent and
            // visible, never a silent bypass"). Applied to the post-flip body
            // when there is one, and to `current` when the flip itself is a
            // no-op: an idempotent re-application must still not lose the
            // waiver. See forced-past-stamp.ts.
            const waived = stampForcedPastWaiver(mutation.newBody ?? current, forcedPast);
            const finalBody = waived ?? mutation.newBody;
            if (finalBody === null) {
              // Already at the target and already stamped (or non-terminal),
              // with no waiver to record — success, nothing written.
              return {
                newBody: null,
                value: {
                  ok: true,
                  oldStatus: mutation.oldStatus,
                  newStatus: status,
                  changed: false,
                  nowStamped: false,
                  forcedPastStamped: false,
                },
              };
            }
            return {
              // A terminal flip — or an idempotent re-application to an old
              // terminal plan — stamps the cold-resume anchor in this SAME
              // locked write. See terminal-now-stamp.ts / WI-38303.
              newBody: bumpUpdatedDate(finalBody),
              value: {
                ok: true,
                oldStatus: mutation.oldStatus,
                newStatus: status,
                changed: mutation.changed,
                nowStamped: mutation.nowStamped,
                forcedPastStamped: waived !== null,
              },
            };
          },
        );

        if (result.kind === 'busy') {
          return {
            ok: false as const,
            slug,
            error: 'busy',
            busy: result.busy.map((b) => ({
              path: b.path,
              owner_label: b.owner_label,
              intent: b.intent,
              expires_ts: b.expires_ts,
            })),
          };
        }

        // Domain failures return ok:false as a normal result so callers read
        // per-item status instead of catching.
        if (!result.value.ok) {
          return { ok: false as const, slug, error: result.value.code, current: result.value.current ?? null };
        }

        if (result.value.changed) {
          await emitPlanEventForCaller(ctx, {
            planSlug: slug,
            event: 'status_changed',
            before: result.value.oldStatus,
            after: status,
          });
        }

        if (isTerminalPlanStatus(status)) {
          try {
            await clearStartedForTerminalPlan(result.scope.workspaceId, result.scope.harnessSlug, slug);
          } catch {
            /* recovered by reconcileStartStatus on the next plans:list read */
          }
        }

        // Lifecycle tidy-up (acceptance-rubrics-on-every-plan-2026-08-11 P-005): the
        // acceptance rubric archives WITH its shipped subject plan. Best-effort — the
        // helper never throws and a busy lock is simply skipped (the rubric stays
        // resolvable by id either way).
        let acceptanceRubricRetired: string | null = null;
        if (status === 'shipped' && result.value.changed) {
          const id = resolveAgentIdentity(ctx);
          acceptanceRubricRetired = await retireAcceptanceRubricForPlan(slug, id.ownerId);
        }

        let learningsObservation:
          | { emitted: true; created: boolean; issueId?: string }
          | { emitted: false; error: string }
          | undefined;
        if (status === 'superseded' && args.learnings) {
          const id = resolveAgentIdentity(ctx);
          const ctxRole = (ctx as { role?: string } | undefined)?.role;
          const deprecatedBy = ctxRole === 'mug' ? 'Queen' : 'owner';
          try {
            const obs = await emitDeprecateLearnings({
              planSlug: slug,
              deprecatedBy,
              learnings: args.learnings as DeprecateLearnings,
              sourceHive: args.sourceHive ?? resolveEffectiveHarnessSlug(sctx),
              ...(args.evidence ? { evidence: args.evidence } : {}),
              createdBy: id.ownerId,
            });
            learningsObservation = {
              emitted: true,
              created: obs.created,
              ...(obs.issue ? { issueId: obs.issue.id } : {}),
            };
          } catch (err) {
            const error =
              err instanceof ObservationEvidenceError ? err.message : err instanceof Error ? err.message : String(err);
            learningsObservation = { emitted: false, error };
          }
        }

        return {
          ...result.value,
          ok: true as const,
          slug,
          filePath: result.filePath,
          ...(mappedFrom ? { mappedFrom } : {}),
          ...(learningsObservation ? { learningsObservation } : {}),
          ...(acceptanceRubricRetired ? { acceptanceRubricRetired } : {}),
          // A forced ship is loud in the RESPONSE too, not only in the plan
          // file: the caller who waived the gate should not have to re-read the
          // plan to see what they waived.
          ...(forcedPast ? { forcedPast: { reason: forcedPast.reason, checks: [...forcedPast.checks] } } : {}),
          revision: result.value.changed && rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
