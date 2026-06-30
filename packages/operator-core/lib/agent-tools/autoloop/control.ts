/**
 * autoloop:control — pause/resume a harness's blueprint-scheduled autoloop, or
 * reset its error circuit (autoloop-pot-operator-rebuild-2026-06-05 P-010).
 *
 * The autoloop is no longer a process-local ticker — it is the durable routines
 * engine firing the harness's blueprint-declared schedule (`bp-schedule-*`
 * routines, materialized by harness:create). So:
 *   - pause/resume = flip those routine rows' `active` (durable, cross-process,
 *     survives restarts — unlike the old in-process timer clear).
 *   - reset-errors = zero `consecutive_errors` in autoloop_state, closing the
 *     P-009 backoff circuit so the next scheduled fire goes out immediately.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resetFireErrors } from '../../autoloop';
import { activeWorkspaceId } from '../../workspace-registry';
import { isWorkspaceCoordinationOn, workspaceBrainReadKeys } from '../../workspace-brain-scope';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

/** The blueprint-schedule routine-name prefix `materializeBlueprintTriggers` seeds. */
const BP_SCHEDULE_PREFIX = 'bp-schedule-';

export default defineTool({
  name: 'autoloop:control',
  profile: 'engineer',
  guidance: {
    when: 'User says "pause the autoloop", "turn autopilot back on", or a circuit-open harness needs its error counter reset after a fix. Per-harness, durable.',
    notWhen: 'For PAUSING all of the operator (silence-mode-style), use the operator-pause flag — autoloop is per-harness. For pausing git-sync or another non-schedule routine, flip that routine directly.',
    chaining: 'autoloop:status first to see the schedule routines + circuit state; reset-errors after fixing whatever made the fires fail.',
  },
  description:
    "Pause/resume a harness's blueprint-scheduled autoloop (flips its bp-schedule-* routine rows — durable) or reset its error circuit (zeroes consecutive_errors so backoff stops withholding fires).",
  capability: 'autoloop:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    op: z.enum(['pause', 'resume', 'reset-errors']),
    harness: z.string().max(120).optional().describe('Harness slug (or via spawn ctx).'),
    role: z.string().max(80).optional().describe("reset-errors only: a single role's counter (default: all roles)."),
  }),
  // Declarative precondition (D-006): a harness must be named — by arg or ctx.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [
          { 'args.harness': { truthy: true } },
          { 'ctx.harnessSlug': { truthy: true } },
        ],
      },
      error: 'autoloop:control — harness slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // The `harness-slug` precondition guarantees a slug arrived, but the operator
    // `'*'` auto-default is truthy and slips past it — route through the fail-loud
    // resolver so a `'*'`/all scope can't silently no-op the routine UPDATE (P-004).
    const slug = resolveConcreteHarnessSlug(args.harness, ctx);
    if (!slug) {
      return harnessRequiredResult('autoloop:control');
    }
    const { sql } = getOrgPg();

    if (args.op === 'reset-errors') {
      const workspaceId =
        typeof ctx.workspaceId === 'string' && ctx.workspaceId.trim()
          ? ctx.workspaceId.trim()
          : activeWorkspaceId();
      const scopes = workspaceBrainReadKeys(workspaceId, slug, await isWorkspaceCoordinationOn());
      const results = [];
      for (const scope of scopes) {
        results.push({ harness: scope, rowsReset: await resetFireErrors(scope, args.role) });
      }
      const n = results.reduce((sum, r) => sum + r.rowsReset, 0);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              op: 'reset-errors',
              harness: slug,
              rowsReset: n,
              ...(results.length > 1 ? { scopes: results } : {}),
            }),
          },
        ],
      };
    }

    const active = args.op === 'resume';
    const rows = await sql<{ name: string }[]>`
      UPDATE harness_shared.routines
         SET active = ${active}, updated_at = now()
       WHERE install_slug = ${slug}
         AND name LIKE ${BP_SCHEDULE_PREFIX + '%'}
      RETURNING name
    `;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            op: args.op,
            harness: slug,
            routines: rows.map((r) => r.name),
            note: rows.length === 0 ? 'no bp-schedule-* routines for this harness (its blueprint declares no schedule)' : undefined,
          }),
        },
      ],
    };
  },
});
