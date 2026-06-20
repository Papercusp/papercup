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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { clearStartedForTerminalPlan, isTerminalPlanStatus } from './plan-start-state';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitDeprecateLearnings, type DeprecateLearnings } from '../../harness/improvements/deprecate-learnings';
import { ObservationEvidenceError } from '../../harness/improvements/observation-types';

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

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
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
    .describe('Optional note on why the lifecycle moved. Stored on the plan revision (D-009), not in the frontmatter.'),
  // ── queen-scout-feedback-loop-2026-06-20 P-006 / B10: the DEPRECATE path.
  learnings: z
    .object({
      tried: z.string().min(1).describe('what approach / premise was attempted on the draft'),
      stalled: z.string().min(1).describe("why it stalled — the reason it won't reach ready"),
      salvageable: z
        .string()
        .min(1)
        .describe("what's salvageable — the reusable signal a future Scout cycle can re-ideate from"),
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
});

type SetPlanStatusValue =
  | { ok: true; oldStatus: string | null; newStatus: string; changed: boolean }
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

export default defineTool({
  name: 'plans:set-plan-status',
  description:
    "Flip a plan's lifecycle status (draft→ready approve, ready→draft demote, →shipped, →superseded reject). Plan-level frontmatter, not an item's status. Auto-bumps updated:. THE DEPRECATE HANDLER for the Queen↔Scout loop: pass `learnings` (what was tried / why it stalled / what's salvageable) with status='superseded' and it ALSO emits a structured, source-tagged learnings observation into the observation lane, so a dead draft still feeds Scout's digest (no dead ends).",
  guidance: {
    when: "Moving a whole plan through its lifecycle: approving a reviewed draft (draft→ready, which unlocks Start), demoting an approved plan back to draft, shipping it, or rejecting it (→superseded). DEPRECATING a Queen↔Scout draft that won't reach ready: status='superseded' + `learnings:{tried,stalled,salvageable}` — one atomic call deprecates AND records the salvage observation (don't file a separate improvements:capture).",
    notWhen:
      "Flipping a P-NNN item's status — use plans:set-status. Converting a legacy plan that has no valid frontmatter — use plans:set-frontmatter first (this verb refuses it with no_status_line). `learnings` on a non-superseded status is ignored (it is a deprecate-only field).",
    chaining:
      "plans:get (read current status) → plans:set-plan-status { slug, status: 'ready', expectedCurrent: 'draft' } to approve. Approving is optional before plans:start — starting a draft auto-approves it (draft→ready). Deprecate: plans:set-plan-status { slug, status:'superseded', learnings:{…} } → the returned learningsObservation reports the emitted observation.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    // Caller-DX (P-006): map a friendly alias (active→ready, done→shipped) to canonical.
    const { status, mappedFrom } = normalizePlanStatus(args.status);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<SetPlanStatusValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-plan-status → ${status}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetPlanStatusValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }
        const flip = flipPlanFrontmatterStatus(current, status, args.expectedCurrent);
        if (flip.code === 'no_status_line') {
          return { newBody: null, value: { ok: false, code: 'no_status_line' } };
        }
        if (flip.code === 'unexpected_status') {
          return {
            newBody: null,
            value: { ok: false, code: 'unexpected_status', current: flip.oldStatus },
          };
        }
        if (flip.code === 'noop' || flip.newBody === null) {
          // Already at the target — success, nothing written.
          return {
            newBody: null,
            value: { ok: true, oldStatus: flip.oldStatus, newStatus: status, changed: false },
          };
        }
        return {
          newBody: bumpUpdatedDate(flip.newBody),
          value: { ok: true, oldStatus: flip.oldStatus, newStatus: status, changed: true },
        };
      },
    );

    if (result.kind === 'busy') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'busy',
              busy: result.busy.map((b) => ({
                path: b.path,
                owner_label: b.owner_label,
                intent: b.intent,
                expires_ts: b.expires_ts,
              })),
            }),
          },
        ],
        isError: true,
      };
    }

    // Domain failures return ok:false as a normal 200 result (like
    // plans:set-content) so HTTP/UI callers read `ok` rather than catch.
    if (result.value.ok && result.value.changed) {
      await emitPlanEventForCaller(ctx, {
        planSlug: args.slug,
        event: 'status_changed',
        before: result.value.oldStatus,
        after: status,
      });
    }

    // Cross-store invariant (P1-2): a plan AT a terminal status (shipped /
    // superseded) can never be operationally started/paused. Reset its
    // op_status (on the harness_plans row) so the "N waiting" badge + Running
    // bucket stop counting it. This runs on EVERY successful terminal set —
    // including the terminal-NOOP (changed:false), where the frontmatter is
    // already terminal but a started+terminal op-row could still persist (e.g.
    // a raw .md edit set the status, or an earlier clear was missed). Scoping
    // it to `changed` left that violating row uncleared. Idempotent + best-
    // effort: clearStartedForTerminalPlan only touches an active (started/
    // paused) row, and plans:list self-heals on read if this misses.
    if (result.value.ok && isTerminalPlanStatus(status)) {
      try {
        await clearStartedForTerminalPlan(harnessSlug ?? operatorHomeHarnessSlug(), args.slug);
      } catch {
        /* recovered by reconcileStartStatus on the next plans:list read */
      }
    }

    // queen-scout-feedback-loop-2026-06-20 P-006 / B10 — the DEPRECATE path closes
    // the loop: a supersede that carries `learnings` ALSO emits a structured,
    // source-tagged learnings observation, so a dead draft still feeds Scout's
    // corpus-digest (no dead ends, D-002). Atomic with the supersede — ONE call
    // deprecates AND records the salvage, so the observation can't be forgotten.
    let learningsObservation:
      | { emitted: true; created: boolean; issueId?: string }
      | { emitted: false; error: string }
      | undefined;
    if (result.value.ok && status === 'superseded' && args.learnings) {
      const id = resolveAgentIdentity(ctx);
      // Attribution is DERIVED from the caller (never spoofable), mirroring
      // scout:grade-idea: the Queen deprecates as 'Queen', every other surface
      // (su / operator) as 'owner'. A Scout self-deprecate calls
      // emitDeprecateLearnings directly with deprecatedBy:'Scout' from its cycle.
      const deprecatedBy = (ctx as { role?: string } | undefined)?.role === 'queen' ? 'Queen' : 'owner';
      try {
        const obs = await emitDeprecateLearnings({
          planSlug: args.slug,
          deprecatedBy,
          learnings: args.learnings as DeprecateLearnings,
          sourceHive: args.sourceHive ?? harnessSlug ?? operatorHomeHarnessSlug(),
          ...(args.evidence ? { evidence: args.evidence } : {}),
          createdBy: id.ownerId,
        });
        learningsObservation = {
          emitted: true,
          created: obs.created,
          ...(obs.issue ? { issueId: obs.issue.id } : {}),
        };
      } catch (err) {
        // The supersede already committed; a failed emit is REPORTED (not fatal)
        // so the caller can re-file rather than losing the salvage silently.
        const error =
          err instanceof ObservationEvidenceError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        learningsObservation = { emitted: false, error };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...result.value,
            filePath: result.filePath,
            ...(mappedFrom ? { mappedFrom } : {}),
            ...(learningsObservation ? { learningsObservation } : {}),
            revision:
              result.value.ok && result.value.changed && rev.recorded.current
                ? { seq: rev.recorded.current.seq }
                : null,
          }),
        },
      ],
    };
  },
});
