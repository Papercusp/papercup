/**
 * soak-report.ts — a machine-checkable production-readiness gate for a pot.
 *
 * WI-1501 asks for one deterministic verdict over a rolling 12–24h window:
 * READY only when the pot has stayed healthy across the full window, otherwise
 * NOT-READY with concrete failing reasons. The report is DERIVED on demand from
 * existing durable signals (spawn rows, placement ledger, open escalations,
 * pipeline history, ticker health) plus the local bg-host journal for restart /
 * OOM evidence.
 *
 * The two halves mirror the repo's usual pattern:
 *   - pure parsers + verdict logic (`parseBgHostJournal*`, `computeSoakReport`)
 *   - the production edge (`readPotSoakReport`) that stitches PG + journalctl.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { probeBgHostTicker } from '../service-health';
import { activeWorkspaceId } from '../workspace-registry';
import { resolvePotMembership } from './survey';

const execFileAsync = promisify(execFile);

export const DEFAULT_SOAK_WINDOW_HOURS = 24;
export const MIN_SOAK_WINDOW_HOURS = 12;
export const MAX_SOAK_WINDOW_HOURS = 24;
export const DEPLOY_LATENCY_THRESHOLD_MS = 15 * 60_000;

export interface BgHostJournalMetrics {
  oomKillCount: number;
  restartCount: number;
  peakMemoryMb: number | null;
  highMemoryPeakCount: number;
}

export interface RoleTurnSuccess {
  role: 'cup' | 'mug' | 'kettle';
  totalTerminalTurns: number;
  successfulTurns: number;
  successRate: number | null;
}

export interface EscalationBacklogMetrics {
  openNow: number;
  olderOpenCount: number;
  newerOpenCount: number;
  improving: boolean;
}

export interface InfraCurseMetrics {
  placementsSeen: number;
  infraCurses: number;
  rate: number | null;
}

export interface DeployLatencyMetrics {
  samples: number;
  meanMs: number | null;
}

/** Mean injected bytes per loop wake above which the P-001 wake diet has regressed
 *  (compaction-continuity-hardening-2026-07-07 P-008). Post-diet live baseline is
 *  ~1.5k chars mean; the pre-diet full-boilerplate-every-wake behavior sat ≥3k. */
export const WAKE_MEAN_CHAR_BUDGET = 3_000;

/** How long after a compaction an error/owner-kick is attributed to it. */
export const POST_COMPACTION_MARKER_WINDOW_MIN = 15;

/** The post-compaction regression markers: a resumed session acting on hallucinated
 *  schema (column/relation-not-found) right after its context was rebuilt. */
export const POST_COMPACTION_ERROR_MARKER_REGEX =
  'column .* does not exist|relation .* does not exist|no such column';

/**
 * Context-burn telemetry (P-008): what the coordination layer itself injects into
 * agent contexts, and how often that forces compactions. WORKSPACE-scoped (wake
 * deliveries + compactions key on owner ids, not harness membership), unlike the
 * pot-scoped metrics above. `requestedCompactions` counts session:request-compaction
 * calls — the disciplined path; native auto-compactions leave no durable row.
 */
export interface ContextBurnMetrics {
  /** coord:inbox-wake deliveries queued in the window (the wake meter, D-007). */
  loopWakes: number;
  meanWakeChars: number | null;
  maxWakeChars: number | null;
  /** meanWakeChars / 4 — the usual chars-per-token heuristic. */
  estMeanWakeTokens: number | null;
  requestedCompactions: number;
  /** Distinct owners that requested a compaction in the window. */
  sessionsCompacting: number;
  compactionsPerSession: number | null;
  /** Failed tool calls matching POST_COMPACTION_ERROR_MARKER_REGEX within
   *  POST_COMPACTION_MARKER_WINDOW_MIN of the same owner's compaction — the
   *  regression metric for compaction-continuity-hardening-2026-07-07. */
  postCompactionErrorMarkers: number;
}

export interface PotSoakReport {
  potSlug: string;
  surveyScope: 'members' | 'workspace';
  surveySlugs: string[];
  windowHours: number;
  generatedAt: string;
  ready: boolean;
  reasons: string[];
  bgHost: BgHostJournalMetrics & { tickerUp: boolean; tickerNote: string | null };
  roleSuccess: RoleTurnSuccess[];
  infraCurse: InfraCurseMetrics;
  escalationBacklog: EscalationBacklogMetrics;
  gateGreenRatio: { green: number; total: number; ratio: number | null };
  deployLatency: DeployLatencyMetrics;
  contextBurn: ContextBurnMetrics;
}

export interface PotSoakReportSnapshot {
  hives: PotSoakReport[];
}

export interface SoakReportInput {
  potSlug: string;
  surveyScope: 'members' | 'workspace';
  surveySlugs: string[];
  windowHours: number;
  generatedAtMs: number;
  bgHost: BgHostJournalMetrics & { tickerUp: boolean; tickerNote: string | null };
  roleSuccess: RoleTurnSuccess[];
  infraCurse: InfraCurseMetrics;
  escalationBacklog: EscalationBacklogMetrics;
  gateGreenRatio: { green: number; total: number; ratio: number | null };
  deployLatency: DeployLatencyMetrics;
  contextBurn: ContextBurnMetrics;
}

function clampWindowHours(windowHours?: number): number {
  const n = Math.trunc(windowHours ?? DEFAULT_SOAK_WINDOW_HOURS);
  if (!Number.isFinite(n)) return DEFAULT_SOAK_WINDOW_HOURS;
  return Math.min(Math.max(n, MIN_SOAK_WINDOW_HOURS), MAX_SOAK_WINDOW_HOURS);
}

function parseMemoryPeakMb(line: string): number | null {
  const m = line.match(/,\s*([0-9.]+)G memory peak/i) ?? line.match(/,\s*([0-9.]+)M memory peak/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /G memory peak/i.test(line) ? Math.round(n * 1024) : Math.round(n);
}

export function parseBgHostUnitJournal(text: string): BgHostJournalMetrics {
  const lines = text.split('\n').filter(Boolean);
  let oomKillCount = 0;
  let restartCount = 0;
  let peakMemoryMb: number | null = null;
  let highMemoryPeakCount = 0;
  for (const line of lines) {
    if (/Started papercup-bg-host\.service/i.test(line)) restartCount += 1;
    if (/OOM killer|FatalProcessOutOfMemory|ReportOOMFailure|Out of memory/i.test(line)) oomKillCount += 1;
    const peakMb = parseMemoryPeakMb(line);
    if (peakMb != null) {
      peakMemoryMb = peakMemoryMb == null ? peakMb : Math.max(peakMemoryMb, peakMb);
      if (peakMb >= 3200) highMemoryPeakCount += 1;
    }
  }
  return { oomKillCount, restartCount, peakMemoryMb, highMemoryPeakCount };
}

export function parseBgHostGlobalJournal(text: string): number {
  return text
    .split('\n')
    .filter((line) => /papercup-bg-host|bg-host/i.test(line))
    .filter((line) => /OOM killer|FatalProcessOutOfMemory|ReportOOMFailure|Out of memory/i.test(line)).length;
}

export function computeSoakReport(input: SoakReportInput): PotSoakReport {
  const reasons: string[] = [];
  if (!input.bgHost.tickerUp) {
    reasons.push(`bg-host ticker unhealthy${input.bgHost.tickerNote ? `: ${input.bgHost.tickerNote}` : ''}`);
  }
  if (input.bgHost.oomKillCount > 0) {
    reasons.push(`bg-host OOM evidence in window (${input.bgHost.oomKillCount})`);
  }
  if (input.bgHost.restartCount > 0) {
    reasons.push(`bg-host restarted ${input.bgHost.restartCount} time(s) in window`);
  }
  if (input.infraCurse.rate == null) {
    reasons.push('no placement evidence for infra-curse rate');
  } else if (input.infraCurse.infraCurses > 0) {
    reasons.push(`infra-attributed curse rate non-zero (${Math.round(input.infraCurse.rate * 100)}%)`);
  }
  for (const role of input.roleSuccess) {
    if (role.successRate == null) {
      reasons.push(`no terminal ${role.role} turns in window`);
    } else if (role.successRate < 1) {
      reasons.push(`${role.role} turn success below 100% (${Math.round(role.successRate * 100)}%)`);
    }
  }
  if (input.escalationBacklog.openNow > 0) {
    reasons.push(`open escalation backlog present (${input.escalationBacklog.openNow})`);
    if (!input.escalationBacklog.improving) {
      reasons.push('open escalation backlog is not shrinking');
    }
  }
  if (input.gateGreenRatio.ratio == null) {
    reasons.push('no green-checkpoint evidence in window');
  } else if (input.gateGreenRatio.ratio < 1) {
    reasons.push(`green-checkpoint ratio below 100% (${Math.round(input.gateGreenRatio.ratio * 100)}%)`);
  }
  if (input.deployLatency.meanMs == null) {
    reasons.push('no deploy-latency evidence in window');
  } else if (input.deployLatency.meanMs > DEPLOY_LATENCY_THRESHOLD_MS) {
    reasons.push(`mean deploy latency above ${Math.round(DEPLOY_LATENCY_THRESHOLD_MS / 60_000)}m`);
  }
  // Context burn (P-008) reds only on POSITIVE bad evidence — a window with no loop
  // wakes / no compactions is a quiet system, not missing evidence (unlike roles/gate
  // above, loops and compactions are not required activity for a healthy pot).
  if (input.contextBurn.meanWakeChars != null && input.contextBurn.meanWakeChars > WAKE_MEAN_CHAR_BUDGET) {
    reasons.push(
      `per-wake injected overhead above budget (mean ${input.contextBurn.meanWakeChars} chars > ${WAKE_MEAN_CHAR_BUDGET})`,
    );
  }
  if (input.contextBurn.postCompactionErrorMarkers > 0) {
    reasons.push(`post-compaction error markers in window (${input.contextBurn.postCompactionErrorMarkers})`);
  }

  return {
    potSlug: input.potSlug,
    surveyScope: input.surveyScope,
    surveySlugs: input.surveySlugs,
    windowHours: input.windowHours,
    generatedAt: new Date(input.generatedAtMs).toISOString(),
    ready: reasons.length === 0,
    reasons,
    bgHost: input.bgHost,
    roleSuccess: input.roleSuccess,
    infraCurse: input.infraCurse,
    escalationBacklog: input.escalationBacklog,
    gateGreenRatio: input.gateGreenRatio,
    deployLatency: input.deployLatency,
    contextBurn: input.contextBurn,
  };
}

type SpawnAggRow = {
  child_role: 'cup' | 'mug' | 'kettle';
  total_terminal: number;
  successful: number;
};

type CurseAggRow = {
  placements_seen: number;
  infra_curses: number;
};

type EscalationAggRow = {
  open_now: number;
  older_open_count: number;
  newer_open_count: number;
};

type PipelineAggRow = {
  green_total: number;
  green_success: number;
};

type PipelineEventRow = {
  kind: string;
  status: string;
  created_at: string | Date;
};

type WakeBurnAggRow = {
  loop_wakes: number;
  mean_wake_chars: number | null;
  max_wake_chars: number | null;
};

type CompactionAggRow = {
  compactions: number;
  sessions: number;
  post_markers: number;
};

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

async function readBgHostJournal(windowHours: number): Promise<BgHostJournalMetrics> {
  const since = `${windowHours} hours ago`;
  try {
    const [unit, global] = await Promise.all([
      execFileAsync('journalctl', ['--user', '-u', 'papercup-bg-host.service', '--since', since, '--no-pager'], { maxBuffer: 8 * 1024 * 1024 }),
      execFileAsync('journalctl', ['--user', '--since', since, '--no-pager'], { maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const parsed = parseBgHostUnitJournal(unit.stdout);
    return {
      ...parsed,
      oomKillCount: Math.max(parsed.oomKillCount, parseBgHostGlobalJournal(global.stdout)),
    };
  } catch {
    return { oomKillCount: 0, restartCount: 0, peakMemoryMb: null, highMemoryPeakCount: 0 };
  }
}

function roleSuccessRowsToView(rows: SpawnAggRow[]): RoleTurnSuccess[] {
  const byRole = new Map(rows.map((row) => [row.child_role, row]));
  return (['cup', 'mug', 'kettle'] as const).map((role) => {
    const row = byRole.get(role);
    const totalTerminalTurns = Number(row?.total_terminal ?? 0);
    const successfulTurns = Number(row?.successful ?? 0);
    return {
      role,
      totalTerminalTurns,
      successfulTurns,
      successRate: totalTerminalTurns > 0 ? successfulTurns / totalTerminalTurns : null,
    };
  });
}

function computeDeployLatency(rows: PipelineEventRow[]): DeployLatencyMetrics {
  const ordered = rows
    .slice()
    .sort((a, b) => toMs(a.created_at) - toMs(b.created_at));
  let pendingGreenAt: number | null = null;
  const deltas: number[] = [];
  for (const row of ordered) {
    if (row.kind === 'green_checkpoint' && (row.status === 'advanced' || row.status === 'up-to-date')) {
      pendingGreenAt = toMs(row.created_at);
      continue;
    }
    if (row.kind === 'deploy' && row.status === 'ok' && pendingGreenAt != null) {
      deltas.push(Math.max(0, toMs(row.created_at) - pendingGreenAt));
      pendingGreenAt = null;
    }
  }
  return {
    samples: deltas.length,
    meanMs: deltas.length ? Math.round(deltas.reduce((sum, n) => sum + n, 0) / deltas.length) : null,
  };
}

export async function readPotSoakReport(
  potSlug: string,
  opts: { windowHours?: number; sql?: Sql } = {},
): Promise<PotSoakReport> {
  const windowHours = clampWindowHours(opts.windowHours);
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = activeWorkspaceId();
  const membership = await resolvePotMembership(workspaceId, potSlug);
  const surveySlugs = membership.surveySlugs.length > 0 ? membership.surveySlugs : [potSlug];

  const [
    ticker,
    journal,
    spawnRows,
    curseRows,
    escalationRows,
    pipelineAggRows,
    pipelineEventRows,
    wakeBurnRows,
    compactionRows,
  ] = await Promise.all([
    probeBgHostTicker(),
    readBgHostJournal(windowHours),
    sql<SpawnAggRow[]>`
      SELECT child_role,
             count(*) FILTER (WHERE status IN ('done', 'failed', 'cancelled', 'reaped'))::int AS total_terminal,
             count(*) FILTER (WHERE status = 'done')::int AS successful
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ANY(${sql.array(surveySlugs)})
         AND child_role IN ('cup', 'mug', 'kettle')
         AND started_at >= now() - make_interval(hours => ${windowHours})
       GROUP BY 1
    `,
    sql<CurseAggRow[]>`
      SELECT count(*)::int AS placements_seen,
             count(*) FILTER (
               WHERE status = 'cursed'
                 AND COALESCE(fail_count, 0) = 0
                 AND COALESCE(infra_loss_count, 0) > 0
             )::int AS infra_curses
        FROM harness_shared.pot_placements
       WHERE workspace_id = ${workspaceId}
         AND install_slug = ${potSlug}
         AND updated_at >= now() - make_interval(hours => ${windowHours})
    `,
    sql<EscalationAggRow[]>`
      WITH scoped AS (
        SELECT ts
          FROM harness_shared.coord_open_escalations
         WHERE workspace_id = ${workspaceId}
           AND COALESCE(
                 body::jsonb ->> 'harnessSlug',
                 body::jsonb ->> 'harness_slug',
                 body::jsonb ->> 'harness',
                 ''
               ) = ANY(${sql.array(surveySlugs)})
      )
      SELECT count(*)::int AS open_now,
             count(*) FILTER (
               WHERE ts < now() - make_interval(hours => ${Math.max(1, Math.floor(windowHours / 2))})
             )::int AS older_open_count,
             count(*) FILTER (
               WHERE ts >= now() - make_interval(hours => ${Math.max(1, Math.floor(windowHours / 2))})
             )::int AS newer_open_count
        FROM scoped
    `,
    sql<PipelineAggRow[]>`
      SELECT count(*) FILTER (
               WHERE kind = 'green_checkpoint'
                 AND status NOT IN ('skipped-disabled', 'skipped-locked')
             )::int AS green_total,
             count(*) FILTER (
               WHERE kind = 'green_checkpoint'
                 AND status IN ('advanced', 'up-to-date')
             )::int AS green_success
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${potSlug}
         AND created_at >= now() - make_interval(hours => ${windowHours})
    `,
    sql<PipelineEventRow[]>`
      SELECT kind, status, created_at
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${potSlug}
         AND created_at >= now() - make_interval(hours => ${windowHours})
         AND (
           (kind = 'green_checkpoint' AND status IN ('advanced', 'up-to-date'))
           OR (kind = 'deploy' AND status = 'ok')
         )
       ORDER BY created_at ASC
    `,
    // Context burn (P-008), workspace-scoped: the wake meter (event_wake_deliveries,
    // D-007) carries every queued loop/coord wake's injected summary.
    sql<WakeBurnAggRow[]>`
      SELECT count(*)::int AS loop_wakes,
             round(avg(length(summary)))::int AS mean_wake_chars,
             max(length(summary))::int AS max_wake_chars
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${workspaceId}
         AND event_key LIKE 'coord:inbox-wake:%'
         AND created_at >= now() - make_interval(hours => ${windowHours})
    `,
    // Requested compactions per owner + the post-compaction error markers: failed
    // calls matching the hallucinated-schema class within the attribution window
    // of the SAME owner's compaction.
    sql<CompactionAggRow[]>`
      WITH compactions AS (
        SELECT coord_owner_id AS owner, invoked_at
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND tool_name = 'session:request-compaction'
           AND status = 'ok'
           AND invoked_at >= now() - make_interval(hours => ${windowHours})
      )
      SELECT (SELECT count(*) FROM compactions)::int AS compactions,
             (SELECT count(DISTINCT owner) FROM compactions WHERE owner IS NOT NULL)::int AS sessions,
             (SELECT count(*)
                FROM harness_shared.tool_invocations ti
               WHERE ti.workspace_id = ${workspaceId}
                 AND ti.invoked_at >= now() - make_interval(hours => ${windowHours})
                 AND ti.status <> 'ok'
                 AND ti.error_message ~* ${POST_COMPACTION_ERROR_MARKER_REGEX}
                 AND EXISTS (
                   SELECT 1
                     FROM compactions c
                    WHERE c.owner IS NOT NULL
                      AND c.owner = ti.coord_owner_id
                      AND ti.invoked_at >= c.invoked_at
                      AND ti.invoked_at < c.invoked_at + make_interval(mins => ${POST_COMPACTION_MARKER_WINDOW_MIN})
                 ))::int AS post_markers
    `,
  ]);

  const curse = curseRows[0] ?? { placements_seen: 0, infra_curses: 0 };
  const escalation = escalationRows[0] ?? { open_now: 0, older_open_count: 0, newer_open_count: 0 };
  const pipeline = pipelineAggRows[0] ?? { green_total: 0, green_success: 0 };
  const deployLatency = computeDeployLatency(pipelineEventRows);
  const wakeBurn = wakeBurnRows[0] ?? { loop_wakes: 0, mean_wake_chars: null, max_wake_chars: null };
  const compaction = compactionRows[0] ?? { compactions: 0, sessions: 0, post_markers: 0 };
  const meanWakeChars = wakeBurn.mean_wake_chars != null ? Number(wakeBurn.mean_wake_chars) : null;
  const sessionsCompacting = Number(compaction.sessions ?? 0);

  return computeSoakReport({
    potSlug,
    surveyScope: membership.scope,
    surveySlugs,
    windowHours,
    generatedAtMs: Date.now(),
    bgHost: {
      ...journal,
      tickerUp: ticker.up,
      tickerNote: ticker.note ?? null,
    },
    roleSuccess: roleSuccessRowsToView(spawnRows),
    infraCurse: {
      placementsSeen: Number(curse.placements_seen ?? 0),
      infraCurses: Number(curse.infra_curses ?? 0),
      rate: Number(curse.placements_seen ?? 0) > 0 ? Number(curse.infra_curses ?? 0) / Number(curse.placements_seen ?? 0) : null,
    },
    escalationBacklog: {
      openNow: Number(escalation.open_now ?? 0),
      olderOpenCount: Number(escalation.older_open_count ?? 0),
      newerOpenCount: Number(escalation.newer_open_count ?? 0),
      improving: Number(escalation.newer_open_count ?? 0) <= Number(escalation.older_open_count ?? 0),
    },
    gateGreenRatio: {
      green: Number(pipeline.green_success ?? 0),
      total: Number(pipeline.green_total ?? 0),
      ratio: Number(pipeline.green_total ?? 0) > 0 ? Number(pipeline.green_success ?? 0) / Number(pipeline.green_total ?? 0) : null,
    },
    deployLatency,
    contextBurn: {
      loopWakes: Number(wakeBurn.loop_wakes ?? 0),
      meanWakeChars,
      maxWakeChars: wakeBurn.max_wake_chars != null ? Number(wakeBurn.max_wake_chars) : null,
      estMeanWakeTokens: meanWakeChars != null ? Math.round(meanWakeChars / 4) : null,
      requestedCompactions: Number(compaction.compactions ?? 0),
      sessionsCompacting,
      compactionsPerSession:
        sessionsCompacting > 0 ? Number(compaction.compactions ?? 0) / sessionsCompacting : null,
      postCompactionErrorMarkers: Number(compaction.post_markers ?? 0),
    },
  });
}
