/**
 * git-pipeline-stats — the composite read behind the /admin Git tab.
 *
 * Stitches together the whole git-sync → green-checkpoint → release pipeline's
 * state + history from the places it actually lives:
 *   - `harness_shared.routines`           — the three routines (git-sync,
 *                                            green-checkpoint, release-trigger):
 *                                            active/cron/schedule + git-sync's
 *                                            latest metadata (last_status,
 *                                            last_resolver, head_sha, …).
 *   - `harness_shared.harness_escalations` — the currently-OPEN merge conflict
 *                                            (git-sync-conflict kind), if any.
 *   - `harness_shared.pipeline_events`     — the append-only history (mig 177):
 *                                            windowed counts + a recent timeline.
 *   - `devDeployState()`                   — the release-gate snapshot (main vs
 *                                            `ready` green pin vs deployed :3070).
 *
 * READ-ONLY: pure aggregation, mutates nothing. Resolves a best-effort snapshot
 * (sub-reads that fail degrade to null/empty) so the panel always renders.
 */
import { getOrgPg } from '@papercusp/db-org';
import { devDeployState, type DevDeployState } from './dev-deploy-state';
import {
  summarizePipelineWindow,
  recentPipelineEvents,
  type PipelineWindowSummary,
  type PipelineEventRow,
} from './harness/git-sync/pipeline-events';

/** The operator's own integration harness (its git-sync/release routines). */
const DEFAULT_SLUG = process.env.RELEASE_ROUTINE_SLUG ?? 'papercup';

export interface RoutineInfo {
  name: string;
  active: boolean;
  cron: string | null;
  lastFiredAtMs: number | null;
  nextFireAtMs: number | null;
}

export interface GitPipelineSnapshot {
  slug: string;
  generatedAtMs: number;

  routines: {
    gitSync: RoutineInfo | null;
    greenCheckpoint: RoutineInfo | null;
    releaseTrigger: RoutineInfo | null;
  };

  /** Latest git-sync tick (from routines.metadata — single newest state). */
  gitSync: {
    lastStatus: string | null;
    lastSyncedAtMs: number | null;
    consecutiveErrorTicks: number;
    headSha: string | null;
    lastPushed: string[];
    lastMerged: string[];
    lastConflicts: string[];
    lastErrors: string[];
  };

  /** The merge-resolver (opus:xhigh) — model + last dispatch outcome. */
  resolver: {
    model: string;
    lastStatus: string | null;
    lastAtMs: number | null;
    lastExitCode: number | null;
    lastHttpStatus: number | null;
    lastTimedOut: boolean | null;
    lastScopes: string[];
  };

  /** The green-checkpoint gate health (P-004): the red streak + time since the
   *  last green + the last release-fixer dispatch — from the green-checkpoint
   *  routine metadata (`gate_health` + `last_fixer`). `stalled` is true once the
   *  red streak / age crossed the alert threshold. */
  gate: {
    consecutiveReds: number;
    lastGreenAtMs: number | null;
    firstRedAtMs: number | null;
    stalled: boolean;
    lastFixerStatus: string | null;
    lastFixerAtMs: number | null;
    lastFixerCandidate: string | null;
  };

  /** A currently-OPEN merge conflict (resolver still working / unresolved), or null. */
  openConflict: {
    scopes: string[];
    conflicts: { scope: string; files: string[] }[];
    emittedAtMs: number | null;
  } | null;

  /** Windowed counts from the append-only history (mig 177). */
  windows: { day: PipelineWindowSummary; week: PipelineWindowSummary };

  /** Recent pipeline events, newest first (the timeline). */
  recent: PipelineEventRow[];

  /** Release-gate snapshot (main vs `ready` vs deployed :3070). */
  deploy: DevDeployState;
}

/** The configured merge-resolver model spec (`AGENT_MODELS` → committed floor). */
export function resolverModel(): string {
  try {
    const raw = process.env.AGENT_MODELS;
    if (raw) {
      const m = JSON.parse(raw) as Record<string, unknown>;
      if (typeof m['merge-resolver'] === 'string' && m['merge-resolver'].trim()) return m['merge-resolver'];
    }
  } catch {
    /* malformed AGENT_MODELS — fall through to the committed default */
  }
  return 'opus:xhigh';
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function dateMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

interface RoutineRow {
  name: string;
  active: boolean;
  trigger_config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  last_fired_at: Date | string | null;
  next_fire_at: Date | string | null;
}

export function toRoutineInfo(r: RoutineRow | undefined): RoutineInfo | null {
  if (!r) return null;
  return {
    name: r.name,
    active: Boolean(r.active),
    cron: typeof r.trigger_config?.cron === 'string' ? (r.trigger_config.cron as string) : null,
    lastFiredAtMs: dateMs(r.last_fired_at),
    nextFireAtMs: dateMs(r.next_fire_at),
  };
}

/** Compute the full pipeline snapshot for `slug` (defaults to the operator's own). */
export async function gitPipelineSnapshot(slug: string = DEFAULT_SLUG): Promise<GitPipelineSnapshot> {
  const { sql } = getOrgPg();

  // The three pipeline routines + git-sync's latest metadata, in one read.
  let routineRows: RoutineRow[] = [];
  try {
    routineRows = await sql<RoutineRow[]>`
      SELECT name, active, trigger_config, metadata, last_fired_at, next_fire_at
        FROM harness_shared.routines
       WHERE install_slug = ${slug}
         AND name IN ('git-sync', 'green-checkpoint', 'release-trigger')
    `;
  } catch {
    routineRows = [];
  }
  const byName = (n: string) => routineRows.find((r) => r.name === n);
  const gitSyncRow = byName('git-sync');
  const meta = (gitSyncRow?.metadata ?? {}) as Record<string, unknown>;
  const lastResolver = (meta.last_resolver ?? null) as Record<string, unknown> | null;
  // P-004: green-checkpoint gate health (red streak + last release-fixer).
  const gcMeta = (byName('green-checkpoint')?.metadata ?? {}) as Record<string, unknown>;
  const gateHealth = (gcMeta.gate_health ?? {}) as Record<string, unknown>;
  const lastFixer = (gcMeta.last_fixer ?? null) as Record<string, unknown> | null;

  // The currently-open merge conflict (git-sync-conflict escalation), if any.
  let openConflict: GitPipelineSnapshot['openConflict'] = null;
  try {
    const escRows = await sql<{ escalation: Record<string, unknown> }[]>`
      SELECT escalation
        FROM harness_shared.harness_escalations
       WHERE harness_slug = ${slug}
         AND escalation IS NOT NULL
         AND (escalation::jsonb ->> 'kind') = 'git-sync-conflict'
       LIMIT 1
    `;
    const esc = escRows[0]?.escalation;
    if (esc) {
      const conflicts = Array.isArray(esc.conflicts)
        ? (esc.conflicts as Array<Record<string, unknown>>).map((c) => ({
            scope: String(c.scope ?? ''),
            files: strArr(c.conflicted_files),
          }))
        : [];
      openConflict = {
        scopes: conflicts.map((c) => c.scope).filter(Boolean),
        conflicts,
        emittedAtMs: num(esc.emitted_at),
      };
    }
  } catch {
    openConflict = null;
  }

  const [day, week, recent, deploy] = await Promise.all([
    summarizePipelineWindow(slug, 24 * 60 * 60),
    summarizePipelineWindow(slug, 7 * 24 * 60 * 60),
    recentPipelineEvents(slug, 25),
    devDeployState(),
  ]);

  return {
    slug,
    generatedAtMs: Date.now(),
    routines: {
      gitSync: toRoutineInfo(gitSyncRow),
      greenCheckpoint: toRoutineInfo(byName('green-checkpoint')),
      releaseTrigger: toRoutineInfo(byName('release-trigger')),
    },
    gitSync: {
      lastStatus: typeof meta.last_status === 'string' ? meta.last_status : null,
      lastSyncedAtMs: num(meta.last_synced_at),
      consecutiveErrorTicks: num(meta.consecutive_error_ticks) ?? 0,
      headSha: typeof meta.head_sha === 'string' ? meta.head_sha : null,
      lastPushed: strArr(meta.last_pushed),
      lastMerged: strArr(meta.last_merged),
      lastConflicts: strArr(meta.last_conflicts),
      lastErrors: strArr(meta.last_errors),
    },
    resolver: {
      model: resolverModel(),
      lastStatus: typeof lastResolver?.status === 'string' ? lastResolver.status : null,
      lastAtMs: num(lastResolver?.at),
      lastExitCode: num(lastResolver?.exitCode),
      lastHttpStatus: num(lastResolver?.httpStatus),
      lastTimedOut: typeof lastResolver?.timedOut === 'boolean' ? lastResolver.timedOut : null,
      lastScopes: strArr(lastResolver?.scopes),
    },
    gate: {
      consecutiveReds: num(gateHealth.consecutiveReds) ?? 0,
      lastGreenAtMs: num(gateHealth.lastGreenAt),
      firstRedAtMs: num(gateHealth.firstRedAt),
      stalled: gateHealth.stallAlerted === true,
      lastFixerStatus: typeof lastFixer?.status === 'string' ? lastFixer.status : null,
      lastFixerAtMs: num(lastFixer?.at),
      lastFixerCandidate: typeof lastFixer?.candidate === 'string' ? lastFixer.candidate : null,
    },
    openConflict,
    windows: { day, week },
    recent,
    deploy,
  };
}
