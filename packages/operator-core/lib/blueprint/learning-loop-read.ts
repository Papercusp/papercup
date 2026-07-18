/**
 * learning-loop-read.ts — the SHARED assembly behind the learning-loop health
 * surfaces (learning-tab-visibility-2026-07-18 P-003).
 *
 * `improvements:learning_loops` (the MCP tool) and the Learning tab's Frontier
 * grid (`learning.frontier` sync resolver) must render the SAME liveness
 * verdicts — instrument integrity (the learning-release-readiness-read D-001
 * posture): one reader, N surfaces, never a parallel derivation that can
 * drift. This module owns the assembly both call: the routine rows for the
 * @singleton + legacy homes, the scout activity ledger, the P-070 platform
 * gate, and the pure {@link computeLearningLoopHealth} classification.
 *
 * The su-ideate activity lane (routine-less, judgment-driven) stays in the
 * MCP tool — it is an extra lane layered ON TOP of the singleton loops this
 * reader classifies, not one of them.
 */
import type { Sql } from 'postgres';
import { LEARNING_SINGLETONS } from './seed-learning-singletons';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import {
  computeLearningLoopHealth,
  singletonRoutineName,
  SINGLETON_HOST_SLUG,
  type LearningLoopHealth,
  type LearningRoutineRow,
} from './learning-loop-health';

export interface ReadLearningLoopHealthOpts {
  /** An active loop that has not fired within this many days is "stale" (default 3). */
  staleAfterDays?: number;
  nowMs?: number;
}

/**
 * Classify every workspace-singleton learning loop's routine health for one
 * workspace. Pure SQL over the injected `sql` (tests stub the seam), then the
 * pure classifier — no tool/transport concerns.
 */
export async function readLearningLoopHealth(
  sql: Sql,
  workspaceId: string,
  opts: ReadLearningLoopHealthOpts = {},
): Promise<LearningLoopHealth[]> {
  // Routine rows for both the @singleton cadence homes and the legacy
  // papercup-slug rows the loops may still live on (pre-migration). Narrowed to
  // the loops we classify; the pure core matches by the exact (slug, name)
  // pair, so over-fetching by name-or-slug is harmless.
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
  const scoutTicks = (await sql`
    SELECT max(tick_at) AS last_tick_at
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${workspaceId}
       AND origin = 'scout'`) as { last_tick_at: Date | string | null }[];
  const lastScoutTickAt = scoutTicks[0]?.last_tick_at ?? null;

  // P-070 deployment gate (EI-10625): a Class-C platform-improvement loop is
  // DELIBERATELY not materialized when platform mode is off, so its missing
  // routine row is by design; every other declared singleton is expected to
  // have one.
  const { platformImprovementLoopsEnabled, isPlatformImprovementLoop } = await import('./materialize-triggers');
  const platformLoopsOn = await platformImprovementLoopsEnabled();

  return computeLearningLoopHealth(LEARNING_SINGLETONS, routines, {
    nowMs: opts.nowMs ?? Date.now(),
    staleAfterDays: opts.staleAfterDays,
    homeSlug: operatorHomeHarnessSlug(),
    expectedMaterialized: (id) => platformLoopsOn || !isPlatformImprovementLoop(id),
    activityByBlueprintId: {
      scout: {
        lastActivityAt: lastScoutTickAt == null ? null : new Date(lastScoutTickAt).toISOString(),
        source: 'scout_ticks',
      },
    },
  });
}
