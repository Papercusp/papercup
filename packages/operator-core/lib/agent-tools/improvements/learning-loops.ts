/**
 * improvements:learning_loops — the dark-loop health surface
 * (relight-self-learning-edges-2026-06-14 P-030).
 *
 * Read-only. The recurring self-learning failure class is a loop BUILT but left
 * silently DARK (seeded inactive behind a default-OFF flag, never armed) or an
 * always-on loop that wedged and stopped firing. Nothing surfaced it. This lists
 * every workspace-singleton learning loop's routine state (firing / stale /
 * dark-by-design vs should-be-on-but-dark / absent) + flags the @singleton↔legacy
 * double-state, so a dark loop is VISIBLE instead of rotting unseen.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { LEARNING_SINGLETONS } from '../../blueprint/seed-learning-singletons';
import {
  computeLearningLoopHealth,
  computeActivityLaneHealth,
  summarizeLearningLoopHealth,
  singletonRoutineName,
  SINGLETON_HOST_SLUG,
  type LearningRoutineRow,
} from '../../blueprint/learning-loop-health';

export default defineTool({
  name: 'improvements:learning_loops',
  profile: 'engineer',
  description:
    'Inspect the self-learning loop routines: per workspace-singleton learning loop (calibration, scout, graduation, iq-battery, …) its routine state — firing / stale (active but not firing) / dark-by-design (frontier, unarmed) / should-be-on-but-dark (an always-on loop gone dark) / absent — plus the @singleton↔legacy double-state. Read-only — the dark-loop visibility surface so a built-but-never-armed loop does not rot unseen.',
  guidance: {
    when: 'To answer "which learning loops are dark / wedged / never armed?" — the standing health of the self-learning machinery (calibration sweep, blender, graduation, gym, iq-battery, …). Catches the recurring class: a loop seeded inactive behind a default-OFF flag that nobody armed, an always-on loop that wedged (stopped firing), or a @singleton↔legacy migration collision.',
    notWhen: 'For the watchdog tick health + auto-implement dispatch ledger use improvements:watchdog-status. For the captured backlog use improvements:digest.',
    chaining:
      'improvements:learning_loops → (a dark frontier loop) the per-lane arming runbook; (a should-be-on-but-dark / stale loop) investigate the routine then improvements:capture.',
    seeAlso: [
      'improvements:watchdog-status (watchdog tick health + auto-implement dispatch ledger)',
      'improvements:digest (the captured backlog itself)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    staleAfterDays: z
      .number()
      .int()
      .positive()
      .max(90)
      .optional()
      .describe('an active loop that has not fired within this many days is "stale" (default 3)'),
    workspace: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('workspace to inspect (default: the session/active workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();

    // Read the routine rows for both the @singleton cadence homes and the legacy
    // papercup-slug rows the loops may still live on (pre-migration). Narrowed to
    // the loops we classify so the read is small; the pure core matches by the
    // exact (slug, name) pair, so over-fetching by name-or-slug is harmless.
    const names = [
      ...new Set([
        ...LEARNING_SINGLETONS.map((l) => singletonRoutineName(l.blueprintId)),
        ...LEARNING_SINGLETONS.map((l) => l.legacyRoutine),
      ]),
    ];
    const rows = (await sql`
      SELECT install_slug, name, active, last_fired_at, next_fire_at
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId}
         AND install_slug IN ${sql([SINGLETON_HOST_SLUG, operatorHomeHarnessSlug()])}
         AND name IN ${sql(names)}`) as {
      install_slug: string;
      name: string;
      active: boolean;
      last_fired_at: Date | string | null;
      next_fire_at: Date | string | null;
    }[];

    const routines: LearningRoutineRow[] = rows.map((r) => ({
      installSlug: r.install_slug,
      name: r.name,
      active: !!r.active,
      lastFiredAt: r.last_fired_at == null ? null : new Date(r.last_fired_at).toISOString(),
      nextFireAt: r.next_fire_at == null ? null : new Date(r.next_fire_at).toISOString(),
    }));
    // origin='scout' (migration 571): su-ideate ticks share this ledger but are
    // NOT Scout activity — counting them here would mask a dead Scout loop.
    const scoutTicks = (await sql<{ last_tick_at: Date | string | null }[]>`
      SELECT max(tick_at) AS last_tick_at
        FROM harness_shared.scout_ticks
       WHERE workspace_id = ${workspaceId}
         AND origin = 'scout'`) as { last_tick_at: Date | string | null }[];
    const lastScoutTickAt = scoutTicks[0]?.last_tick_at ?? null;
    const nowMs = Date.now();

    // P-070 deployment gate (EI-10625): a Class-C platform-improvement loop is
    // DELIBERATELY not materialized when platform mode is off, so its missing routine row
    // is by design. Every other declared singleton is expected to have one — and a missing
    // row there is a registration failure, never a dark-by-design loop (a dark loop still
    // HAS a row). Resolve the gate once and hand it to the pure classifier.
    const { platformImprovementLoopsEnabled, isPlatformImprovementLoop } = await import(
      '../../blueprint/materialize-triggers'
    );
    const platformLoopsOn = await platformImprovementLoopsEnabled();

    const loops = computeLearningLoopHealth(LEARNING_SINGLETONS, routines, {
      nowMs,
      staleAfterDays: args.staleAfterDays,
      homeSlug: operatorHomeHarnessSlug(),
      expectedMaterialized: (id) => platformLoopsOn || !isPlatformImprovementLoop(id),
      activityByBlueprintId: {
        scout: {
          lastActivityAt: lastScoutTickAt == null ? null : new Date(lastScoutTickAt).toISOString(),
          source: 'scout_ticks',
        },
      },
    });

    // su-ideation dark-lane (su-ideate-learning-substrate P-013): a ROUTINE-LESS,
    // judgment-driven learning loop (D-001: no su daemon), so it has no cadence row to
    // classify — its liveness is the max of THREE domain signals: its P-010 pass ledger
    // (scout_ticks origin='su-ideate'), the ideas it actually ROUTES (scout_routed_ideas
    // origin='su-ideate' — WI-5322: the tick ledger stopped being written ~2026-07-14 while
    // routing kept flowing, so ticks+watchdog alone false-reported the live lane as stale),
    // and its P-006 ungraded-filings backstop watchdog fires (pot_watchdog_fires
    // source='su-ideate-ungraded'). All reads fail-soft to null (an absent migration must
    // not break this read-only health surface), so a cold su-ideate subsystem simply reads
    // 'dark-by-design' rather than erroring.
    const suIdeateTicks = (await sql<{ last_tick_at: Date | string | null }[]>`
      SELECT max(tick_at) AS last_tick_at
        FROM harness_shared.scout_ticks
       WHERE workspace_id = ${workspaceId}
         AND origin = 'su-ideate'`) as { last_tick_at: Date | string | null }[];
    let lastSuWatchdogFireAt: Date | string | null = null;
    try {
      const fires = (await sql<{ last_fire_at: Date | string | null }[]>`
        SELECT max(fired_at) AS last_fire_at
          FROM harness_shared.pot_watchdog_fires
         WHERE workspace_id = ${workspaceId}
           AND source = 'su-ideate-ungraded'`) as { last_fire_at: Date | string | null }[];
      lastSuWatchdogFireAt = fires[0]?.last_fire_at ?? null;
    } catch {
      lastSuWatchdogFireAt = null; // pot_watchdog_fires (mig 212) absent → no signal, not an error
    }
    // Routing ledger (WI-5322): the live proof the lane is turning. routed_at is bigint
    // epoch-ms → to_timestamp() so it folds into the same Date-based max as the timestamptz
    // sources above. Fail-soft to null so an absent table never breaks this health read.
    let lastSuRoutedAt: Date | string | null = null;
    try {
      const routed = (await sql<{ last_routed_at: Date | string | null }[]>`
        SELECT to_timestamp(max(routed_at) / 1000.0) AS last_routed_at
          FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${workspaceId}
           AND origin = 'su-ideate'`) as { last_routed_at: Date | string | null }[];
      lastSuRoutedAt = routed[0]?.last_routed_at ?? null;
    } catch {
      lastSuRoutedAt = null; // scout_routed_ideas (mig 571) absent → no signal, not an error
    }
    const suHeartbeatMs = [suIdeateTicks[0]?.last_tick_at ?? null, lastSuWatchdogFireAt, lastSuRoutedAt]
      .map((v) => (v == null ? NaN : new Date(v).getTime()))
      .filter((ms) => !Number.isNaN(ms));
    const suLane = computeActivityLaneHealth(
      {
        blueprintId: 'su-ideation',
        lastActivityAt: suHeartbeatMs.length ? new Date(Math.max(...suHeartbeatMs)).toISOString() : null,
        source: 'su-ideate-routing+ticks+ungraded-watchdog',
      },
      { nowMs, staleAfterDays: args.staleAfterDays },
    );

    const allLoops = [...loops, suLane];
    const summary = summarizeLearningLoopHealth(allLoops);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workspaceId, summary, loops: allLoops }) }] };
  },
});
