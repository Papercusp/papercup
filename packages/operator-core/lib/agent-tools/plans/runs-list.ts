/**
 * plans:runs — the launch history for a plan.
 *
 * plan-agent-launch-2026-05-21, Phase 3 (P-015).
 *
 * One row per agent launched from the plan (the `plan_runs` store),
 * newest-first: run id, title, status, who launched it and when, the
 * launch note, the seeded `plan_content_hash` (P-023's stale-version
 * badge compares it to the plan's current hash), the run's session
 * id, and a transcript turn count. The data behind the Agents tab's
 * past-runs list (P-021).
 *
 * A plan with no runs returns an empty list, not an error (matches
 * `plans:revisions`). A genuine DB failure is reported as
 * `runs_unavailable` rather than a misleading empty list.
 *
 * Each read first runs the poll-based run-status sweep (P-016) —
 * orphaned `running` → `failed`, stale `idle` → `archived` — so this
 * read *is* the v1 lifecycle poll. The sweep is best-effort.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { listPlanRuns, sweepPlanRuns } from './runs';

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename stem) whose run history to read.'),
  harness: harnessArg,
});

export default defineTool({
  name: 'plans:runs',
  description:
    'The launch history for a plan, newest-first — one row per agent launched from it: run id, title, status, who launched it and when, the launch note, the seeded content hash, the session id, and a transcript turn count. Empty list when the plan has never been launched.',
  guidance: {
    when: 'You want to see the agents launched from a plan — the past-runs list, or to find a runId to resume.',
    notWhen:
      'You want to launch a fresh agent — plans:launch. You want to read the plan body — plans:get. The plan’s edit history — plans:revisions.',
    chaining:
      'plans:runs → plans:resume { runId, message } to continue a run.',
    seeAlso: [
      'plans:run-transcript (read one run\'s transcript)',
      'plans:resume (continue a run)',
      'plans:set-run-status (change a run\'s status)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    try {
      // Poll-based run-status lifecycle (P-016): each runs read first
      // sweeps orphaned `running` → `failed` and stale `idle` →
      // `archived`. Best-effort — a sweep failure must not break the
      // list read.
      await sweepPlanRuns().catch((e) => {
        console.warn(
          `[plans:runs] run-status sweep failed: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      });
      const sctx = harnessScopedCtx(args.harness, ctx);
      const harnessSlug = resolveCtxHarnessSlug(sctx);
      const runs = await listPlanRuns(args.slug, harnessSlug ? { harnessSlug } : {});
      ctxAny.metadata?.({ slug: args.slug, runCount: runs.length });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ runs }) }],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'runs_unavailable',
              message: message.slice(0, 400),
              slug: args.slug,
            }),
          },
        ],
        isError: true,
      };
    }
  },
});
