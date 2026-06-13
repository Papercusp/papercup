/**
 * pipeline-events — the append + read helpers over `harness_shared.pipeline_events`
 * (mig 177), the append-only history of the git-sync → green-checkpoint → release
 * pipeline. The /admin Git tab's stats read from here.
 *
 * Before this table the pipeline kept only LATEST-state: git-sync's last status +
 * last resolver outcome in `routines.metadata` (overwritten every tick), the open
 * conflict in `harness_escalations` (overwritten), and nothing at all for
 * green-checkpoint. So counts over time ("how many merge conflicts", "main-green
 * rate") had no source. This is that source.
 *
 * Writes are BEST-EFFORT: a stats-log failure must never affect the pipeline
 * itself, so `appendPipelineEvent` swallows + warns rather than throwing into the
 * git-sync / green-checkpoint handlers that call it.
 *
 * Each fn takes an optional `sql` (the emitUsageEvent seam) — defaults to the
 * operator's org client, injected to a testcontainer client in integration tests.
 */
import { hostname } from 'node:os';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export type PipelineEventKind = 'git_sync' | 'merge_resolver' | 'content_fixer' | 'green_checkpoint' | 'deploy' | 'release_fixer';

function db(sql?: Sql): Sql {
  return sql ?? (getOrgPg().sql as unknown as Sql);
}

/** P-015: which operator process emitted an event. On the shared dev box the desktop +
 *  the systemd :3070 / :3170 operators all run background machinery from DIFFERENT code
 *  trees (release-green vs staging), so "which host ran this tick" was an invisible
 *  lottery when diagnosing. The port discriminates the deployment; pid the process. */
export function hostTag(): string {
  return `${hostname()}:${process.env.PAPERCUSP_HONO_PORT ?? 'dev'}#${process.pid}`;
}

export interface AppendPipelineEvent {
  workspaceId: string;
  installSlug: string;
  kind: PipelineEventKind;
  /** Per-kind outcome string (see the migration header for the vocabulary). */
  status: string;
  detail?: Record<string, unknown>;
}

/** One logged pipeline event (read shape — camelCased, epoch-ms time). */
export interface PipelineEventRow {
  id: string;
  kind: PipelineEventKind;
  status: string;
  detail: Record<string, unknown>;
  createdAtMs: number;
}

/** Append one pipeline event. Best-effort — never throws (warns on failure). */
export async function appendPipelineEvent(ev: AppendPipelineEvent, sql?: Sql): Promise<void> {
  try {
    // P-015: stamp every event with the emitting host/process so the Git tab + a
    // post-mortem can tell WHICH operator ran a given tick (desktop vs :3070 vs :3170).
    const detail = { ...(ev.detail ?? {}), host: hostTag() };
    await db(sql)`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, detail)
      VALUES (${ev.workspaceId || '*'}, ${ev.installSlug}, ${ev.kind}, ${ev.status},
              ${JSON.stringify(detail)}::jsonb)
    `;
  } catch (e) {
    console.warn(`[pipeline-events] append failed (${ev.kind}/${ev.status}): ${e instanceof Error ? e.message : e}`);
  }
}

/** Per-kind/per-status counts over a trailing window. */
export interface PipelineWindowSummary {
  sinceMs: number;
  gitSync: { total: number; synced: number; nothing: number; conflict: number; error: number };
  mergeResolver: { total: number; ok: number; failed: number; error: number };
  greenCheckpoint: {
    total: number;
    advanced: number;
    upToDate: number;
    notGreen: number;
    notFastForward: number;
    createFailed: number;
  };
  /** Auto-serve deploys (staging-branch-pipeline-2026-06-06): one row per attempt. */
  deploy: { total: number; ok: number; rolledBack: number; failed: number; refused: number };
}

export function emptyWindow(sinceMs: number): PipelineWindowSummary {
  return {
    sinceMs,
    gitSync: { total: 0, synced: 0, nothing: 0, conflict: 0, error: 0 },
    mergeResolver: { total: 0, ok: 0, failed: 0, error: 0 },
    greenCheckpoint: { total: 0, advanced: 0, upToDate: 0, notGreen: 0, notFastForward: 0, createFailed: 0 },
    deploy: { total: 0, ok: 0, rolledBack: 0, failed: 0, refused: 0 },
  };
}

/**
 * Fold raw `(kind,status,count)` group rows into the typed window summary. Pure —
 * unit-tested without a DB. Unknown statuses still count toward each kind's total.
 */
export function foldPipelineWindow(
  rows: Array<{ kind: string; status: string; n: number | string }>,
  sinceMs: number,
): PipelineWindowSummary {
  const out = emptyWindow(sinceMs);
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.kind === 'git_sync') {
      out.gitSync.total += n;
      if (r.status === 'synced') out.gitSync.synced += n;
      else if (r.status === 'nothing') out.gitSync.nothing += n;
      else if (r.status === 'conflict') out.gitSync.conflict += n;
      else if (r.status === 'error') out.gitSync.error += n;
    } else if (r.kind === 'merge_resolver') {
      out.mergeResolver.total += n;
      if (r.status === 'ok') out.mergeResolver.ok += n;
      else if (r.status === 'failed') out.mergeResolver.failed += n;
      else if (r.status === 'error') out.mergeResolver.error += n;
    } else if (r.kind === 'green_checkpoint') {
      out.greenCheckpoint.total += n;
      if (r.status === 'advanced') out.greenCheckpoint.advanced += n;
      else if (r.status === 'up-to-date') out.greenCheckpoint.upToDate += n;
      else if (r.status === 'not-green') out.greenCheckpoint.notGreen += n;
      else if (r.status === 'not-fast-forward') out.greenCheckpoint.notFastForward += n;
      else if (r.status === 'create-failed') out.greenCheckpoint.createFailed += n;
    } else if (r.kind === 'deploy') {
      out.deploy.total += n;
      if (r.status === 'ok') out.deploy.ok += n;
      else if (r.status === 'rolled-back') out.deploy.rolledBack += n;
      else if (r.status === 'failed') out.deploy.failed += n;
      else if (r.status === 'refused') out.deploy.refused += n;
    }
  }
  return out;
}

/**
 * Count events for `slug` over the trailing `windowSeconds`, grouped into the
 * per-kind summary the Git tab renders. One grouped query; `foldPipelineWindow`
 * does the typing.
 */
export async function summarizePipelineWindow(
  slug: string,
  windowSeconds: number,
  sql?: Sql,
): Promise<PipelineWindowSummary> {
  const sinceMs = Date.now() - windowSeconds * 1000;
  try {
    const rows = await db(sql)<{ kind: string; status: string; n: number }[]>`
      SELECT kind, status, count(*)::int AS n
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${slug}
         AND created_at >= now() - make_interval(secs => ${windowSeconds})
       GROUP BY kind, status
    `;
    return foldPipelineWindow(rows, sinceMs);
  } catch (e) {
    console.warn(`[pipeline-events] summarize failed: ${e instanceof Error ? e.message : e}`);
    return emptyWindow(sinceMs);
  }
}

/** Most-recent events for `slug` (newest first) — the Git tab's timeline. */
export async function recentPipelineEvents(slug: string, limit = 25, sql?: Sql): Promise<PipelineEventRow[]> {
  try {
    const rows = await db(sql)<{ id: string; kind: string; status: string; detail: unknown; created_at: Date }[]>`
      SELECT id::text, kind, status, detail, created_at
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${slug}
       ORDER BY created_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 200)}
    `;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as PipelineEventKind,
      status: r.status,
      detail: normalizeDetail(r.detail),
      createdAtMs: r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime(),
    }));
  } catch (e) {
    console.warn(`[pipeline-events] recent failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** jsonb comes back as an object under the operator client but can arrive as a
 *  string under some client configs (double-encode) — tolerate both. */
function normalizeDetail(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
