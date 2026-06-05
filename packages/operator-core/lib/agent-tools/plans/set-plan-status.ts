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
import { defineTool } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { clearStartedForTerminalPlan, isTerminalPlanStatus } from './plan-start-state';

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

/** Settable plan-level lifecycle targets. `active` is intentionally
 *  excluded — it is the legacy synonym for `ready` (bucketOf treats it
 *  as approved); new transitions write `ready`. */
const SETTABLE = ['draft', 'ready', 'shipped', 'superseded'] as const;
/** Statuses a caller may guard on via `expectedCurrent` — the full set,
 *  since existing plans can still carry the legacy `active`. */
const GUARDABLE = ['draft', 'ready', 'active', 'shipped', 'superseded'] as const;

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  status: z.enum(SETTABLE).describe('Target plan-level status to flip the frontmatter to.'),
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
    "Flip a plan's lifecycle status (draft→ready approve, ready→draft demote, →shipped, →superseded reject). Plan-level frontmatter, not an item's status. Auto-bumps updated:.",
  guidance: {
    when: 'Moving a whole plan through its lifecycle: approving a reviewed draft (draft→ready, which unlocks Start), demoting an approved plan back to draft, shipping it, or rejecting it (→superseded).',
    notWhen:
      "Flipping a P-NNN item's status — use plans:set-status. Converting a legacy plan that has no valid frontmatter — use plans:set-frontmatter first (this verb refuses it with no_status_line).",
    chaining:
      "plans:get (read current status) → plans:set-plan-status { slug, status: 'ready', expectedCurrent: 'draft' } to approve. Approving is optional before plans:start — starting a draft auto-approves it (draft→ready).",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
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
        intent: `plans:set-plan-status → ${args.status}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetPlanStatusValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }
        const flip = flipPlanFrontmatterStatus(current, args.status, args.expectedCurrent);
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
            value: { ok: true, oldStatus: flip.oldStatus, newStatus: args.status, changed: false },
          };
        }
        return {
          newBody: bumpUpdatedDate(flip.newBody),
          value: { ok: true, oldStatus: flip.oldStatus, newStatus: args.status, changed: true },
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
        after: args.status,
      });
      // Cross-store invariant: a plan that just went terminal (shipped /
      // superseded) can no longer be operationally started/paused. Reset its
      // op_status (on the harness_plans row) so the "N waiting" badge +
      // Running bucket stop counting it. Best-effort — plans:list self-heals a
      // stale row on read if this misses.
      if (isTerminalPlanStatus(args.status)) {
        try {
          await clearStartedForTerminalPlan(harnessSlug ?? 'papercup', args.slug);
        } catch {
          /* recovered by reconcileStartStatus on the next plans:list read */
        }
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...result.value,
            filePath: result.filePath,
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
