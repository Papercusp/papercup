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
 */
import { getOrgPg } from '@papercusp/db-org';

export type PipelineEventKind = 'git_sync' | 'merge_resolver' | 'green_checkpoint' | 'deploy';

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
export async function appendPipelineEvent(ev: AppendPipelineEvent): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, detail)
      VALUES (${ev.workspaceId || '*'}, ${ev.installSlug}, ${ev.kind}, ${ev.status},
              ${JSON.stringify(ev.detail ?? {})}::jsonb)
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
}

function emptyWindow(sinceMs: number): PipelineWindowSummary {
  return {
    sinceMs,
    gitSync: { total: 0, synced: 0, nothing: 0, conflict: 0, error: 0 },
    mergeResolver: { total: 0, ok: 0, failed: 0, error: 0 },
    greenCheckpoint: { total: 0, advanced: 0, upToDate: 0, notGreen: 0, notFastForward: 0, createFailed: 0 },
  };
}

/**
 * Count events for `slug` over the trailing `windowSeconds`, grouped into the
 * per-kind summary the Git tab renders. One grouped query; folds (kind,status)
 * rows into the typed shape. Unknown statuses still count toward `total`.
 */
export async function summarizePipelineWindow(slug: string, windowSeconds: number): Promise<PipelineWindowSummary> {
  const sinceMs = Date.now() - windowSeconds * 1000;
  const out = emptyWindow(sinceMs);
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ kind: string; status: string; n: number }[]>`
      SELECT kind, status, count(*)::int AS n
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${slug}
         AND created_at >= now() - make_interval(secs => ${windowSeconds})
       GROUP BY kind, status
    `;
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
      }
    }
  } catch (e) {
    console.warn(`[pipeline-events] summarize failed: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}

/** Most-recent events for `slug` (newest first) — the Git tab's timeline. */
export async function recentPipelineEvents(slug: string, limit = 25): Promise<PipelineEventRow[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: string; kind: string; status: string; detail: unknown; created_at: Date }[]>`
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
      detail: (r.detail ?? {}) as Record<string, unknown>,
      createdAtMs: r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime(),
    }));
  } catch (e) {
    console.warn(`[pipeline-events] recent failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
