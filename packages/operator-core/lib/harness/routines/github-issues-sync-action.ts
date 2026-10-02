/**
 * `system:github-issues-sync` — runs the GitHub Issues ticket connector on a cadence
 * (plan enterprise-data-sources-2026-10-01 P-019, D-025; modelled on
 * `slack-org-sync-action.ts`).
 *
 * Each fire, for every GitHub Issues source (data source kind `github` whose config
 * says `objects: 'issues'`, connected through `connectGitHubIssuesSource`):
 *   1. skip the source while the connector has paused it for a GitHub rate limit
 *      (`cursor.tickets.nextAt` in the future); every call would hit the same limit;
 *   2. repository membership sync when it has never run or its last run is older than
 *      `membership_interval_sec`. It fills the repository's permission list, which
 *      decides who can read the ticket comments; until it runs, nobody can (fail closed);
 *   3. one bounded poll (`pollGitHubIssuesOnce`): issues as `ticket` records, open/close
 *      transitions as `ticket-status-change` events and comments as documents. The
 *      connector owns paging bounds, the cursor and every 403/429 back-off.
 * A source that throws is marked `degraded` with the error and the fire moves on, so one
 * broken repository never starves the others.
 *
 * No flag: with no GitHub Issues source connected the fire lists nothing and writes nothing.
 *
 * Config (routine `trigger_config`, optional):
 *   - `membership_interval_sec` — membership re-sync period (default 3600, 60..86400).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  GITHUB_ISSUES_PROVIDER,
  pollGitHubIssuesOnce,
  syncGitHubRepoMembership,
  type GitHubIssuesDeps,
} from '../../data-sources/github-issues-connector';
import {
  type ExternalTriggerSourceRow,
  getExternalTriggerSource,
  listPollableExternalTriggerSources,
  updateExternalTriggerSourceSyncState,
} from '../../external-triggers/source-store';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface GitHubIssuesSyncDeps extends GitHubIssuesDeps {
  sql?: postgres.Sql;
}

export interface GitHubIssuesSyncResult {
  sources: number;
  membershipSynced: number;
  polled: number;
  paused: number;
  rateLimited: number;
  tickets: { created: number; updated: number };
  statusChanges: number;
  comments: number;
  failures: Array<{ sourceId: string; error: string }>;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function objectAt(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isIssuesSource(source: ExternalTriggerSourceRow): boolean {
  return source.config?.objects === 'issues';
}

function pausedUntil(source: ExternalTriggerSourceRow, nowMs: number): boolean {
  const nextAt = Date.parse(String(objectAt(source.cursor?.tickets).nextAt ?? ''));
  return Number.isFinite(nextAt) && nextAt > nowMs;
}

function membershipDue(source: ExternalTriggerSourceRow, nowMs: number, intervalMs: number): boolean {
  const syncedAt = Date.parse(String(objectAt(source.cursor?.membership).syncedAt ?? ''));
  return !Number.isFinite(syncedAt) || nowMs - syncedAt >= intervalMs;
}

export function formatGitHubIssuesSyncLog(result: GitHubIssuesSyncResult): string {
  const failures = result.failures.length > 0 ? ` failures=${JSON.stringify(result.failures)}` : '';
  return (
    `[github-issues-sync] sources=${result.sources} membership_synced=${result.membershipSynced} ` +
    `polled=${result.polled} paused=${result.paused} rate_limited=${result.rateLimited} ` +
    `tickets_created=${result.tickets.created} tickets_updated=${result.tickets.updated} ` +
    `status_changes=${result.statusChanges} comments=${result.comments}${failures}`
  );
}

export async function runGitHubIssuesSync(
  ctx: Pick<SystemActionCtx, 'workspaceId' | 'triggerConfig'>,
  provided: GitHubIssuesSyncDeps = {},
): Promise<GitHubIssuesSyncResult> {
  const result: GitHubIssuesSyncResult = {
    sources: 0,
    membershipSynced: 0,
    polled: 0,
    paused: 0,
    rateLimited: 0,
    tickets: { created: 0, updated: 0 },
    statusChanges: 0,
    comments: 0,
    failures: [],
  };
  const sql = provided.sql ?? getOrgPg().sql;
  const now = provided.now ?? (() => new Date());
  const connector: GitHubIssuesDeps = { ...provided, now };
  const membershipIntervalMs = boundedInteger(ctx.triggerConfig?.membership_interval_sec, 3_600, 60, 86_400) * 1_000;

  const sources = (await listPollableExternalTriggerSources(sql, ctx.workspaceId, GITHUB_ISSUES_PROVIDER)).filter(isIssuesSource);
  result.sources = sources.length;
  for (const listed of sources) {
    try {
      let source = listed;
      const nowMs = now().getTime();
      if (pausedUntil(source, nowMs)) {
        result.paused += 1;
        continue;
      }
      if (membershipDue(source, nowMs, membershipIntervalMs)) {
        const synced = await syncGitHubRepoMembership(sql, source, connector);
        // The poll below saves `{ ...source.cursor, tickets }`, so the re-read source carries
        // this marker forward instead of the poll erasing it.
        source = await updateExternalTriggerSourceSyncState(sql, ctx.workspaceId, source.id, {
          status: 'connected',
          cursor: { ...objectAt(source.cursor), membership: { syncedAt: new Date(nowMs).toISOString(), members: synced.members } },
          lastError: null,
        });
        result.membershipSynced += 1;
        source = (await getExternalTriggerSource(sql, ctx.workspaceId, source.id)) ?? source;
      }
      const outcome = await pollGitHubIssuesOnce(sql, source, connector);
      result.tickets.created += outcome.tickets.created;
      result.tickets.updated += outcome.tickets.updated;
      result.statusChanges += outcome.statusChanges;
      result.comments += outcome.comments.written;
      if (outcome.status === 'paused') result.paused += 1;
      else if (outcome.status === 'rate-limited') result.rateLimited += 1;
      else result.polled += 1;
    } catch (cause) {
      const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000);
      await updateExternalTriggerSourceSyncState(sql, ctx.workspaceId, listed.id, { status: 'degraded', lastError: error });
      result.failures.push({ sourceId: listed.id, error });
    }
  }
  return result;
}

registerSystemAction('github-issues-sync', async (ctx) => {
  const result = await runGitHubIssuesSync(ctx);
  if (result.sources > 0) console.log(formatGitHubIssuesSyncLog(result));
});
