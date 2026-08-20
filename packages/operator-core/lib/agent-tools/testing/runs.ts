/**
 * testing:runs — read the TEST-RUN LEDGER (`harness_shared.test_runs`),
 * plan sql-escape-tool-routing-2026-08-12 P-004.
 *
 * Closes a live CONTRADICTION: the su playbook orders agents to green a red
 * gate by finding "the ACTUAL failing tests (query the test-run ledger, don't
 * guess)" — and ships no verb to read that ledger. 40 agents / 288 hand-written
 * `dev:pg_query` calls fill the gap, and the corpus shows they get it wrong in
 * two specific, expensive ways this tool makes unrepresentable.
 *
 * TRAP 1 — TENANT SCOPE (EI-19324633485547042). `workspace_id`/`harness_slug`
 * are stamped ONLY by the per-hive Tests-tab ingestion route. The CI/dogfood
 * vitest reporter writes the SAME table deriving both from env vars that CI
 * never sets, so its rows are NULL on both — 338k rows in the last 7 days,
 * still arriving. A `workspace_id = '…'` predicate therefore excludes EVERY
 * CI/gate row and reads as a clean "no failures". So this tool applies NO
 * workspace predicate by default and scopes by source/commitSha/runGroup, per
 * the remedy already written at testing-run-store.ts:334-343.
 *
 * TRAP 2 — STATUS VOCABULARY. The values are 'pass'/'fail'/'skip', NOT
 * 'passed'/'failed', so a hand-written `status <> 'passed'` matches every row.
 * A typed enum makes that unrepresentable.
 *
 * SHAPE — the corpus is MAJORITY-AGGREGATE ("is this sha/run green": GROUP BY
 * commit_sha/run_group_id with count(*) FILTER (WHERE status='fail')), not
 * row-listing. A row-list-only verb would not cover this relation's real
 * shapes, so `rollup` is a first-class mode, not an afterthought (D-001 §1).
 * Rollups use the same latest-per-file view as the default row listing, so a
 * retry that supersedes a failed attempt cannot poison the aggregate verdict.
 *
 * NOT this tool: cross-run flip-rate ranking ("is this red mine or a known
 * flake") is `testing:flakiness` — same table, different question. Running
 * tests is `testing:run`.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { CRITICAL_P95_MS } from '../../event-loop-lag-monitor';
import { toIso } from '../_pg-timestamp';

const DEFAULT_LIMIT = 30;
const OUTPUT_TAIL_CHARS = 800;

/** The statuses that constitute a RED row. `error` is red too — the corpus's
 *  own `status IN ('fail','error')` filters agree, and a fail-only filter
 *  under-reports a suite that errored before it could fail. */
const RED_STATUSES: string[] = ['fail', 'error'];

// NOT `d.toISOString()`: a timestamptz column arrives as a STRING here, so the old
// spelling threw on every row and left this tool dead on every call. See _pg-timestamp.
const iso = toIso;

/**
 * A red row recorded while the host's event loop was past the critical band is
 * not trustworthy as a genuine failure — the column comment for
 * `loop_lag_p95_ms` says so directly (a timeout-class failure there is likely a
 * saturation artifact). Flagging it is NOT "blame high load": it does not
 * explain the failure away, it marks the row as unable to settle the question
 * and tells the caller to re-run before chasing it.
 *
 * NULL lag is explicitly NOT suspect — the comment is emphatic that NULL means
 * no monitor was running, which is not a claim the host was calm.
 */
export function isSaturationSuspect(loopLagP95Ms: number | null): boolean {
  return loopLagP95Ms !== null && loopLagP95Ms >= CRITICAL_P95_MS;
}

/** file_path is matched as a literal SUBSTRING — the corpus overwhelmingly
 *  reaches for `LIKE '%release-submodule-freshness%'`, a memorable fragment of
 *  a long path, not the exact worktree-relative path. Escape LIKE metacharacters
 *  first so ordinary path names such as `__tests__` cannot become an anchored
 *  wildcard pattern and produce a false absence. */
export function toPathPattern(filePath: string): string {
  const escaped = filePath.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

/** commit_sha is matched as a PREFIX — agents quote a short sha
 *  (`362398846fd2`) while the column holds the full 40-char one. */
export function toShaPattern(sha: string): string {
  return /[%_]/.test(sha) ? sha : `${sha}%`;
}

/**
 * A commit rollup is documented as the commit's CI/gate verdict. Local rows
 * share the same commit SHA while representing an agent's potentially dirty
 * working tree, so they must not silently join that verdict. Callers can
 * still select a different writer explicitly with `source`.
 */
export function defaultRollupSource(
  rollup: 'commit' | 'runGroup' | undefined,
  source?: 'ci' | 'local' | 'admin-ui',
): 'ci' | 'local' | 'admin-ui' | null {
  return source ?? (rollup === 'commit' ? 'ci' : null);
}

export default defineTool({
  name: 'testing:runs',
  description:
    'Read the test-run ledger (harness_shared.test_runs): what actually failed, at which commit, in which run. `rollup:"commit"|"runGroup"` aggregates ("is this sha green" — total/failed/failing-file counts); commit rollups default to `source:"ci"` so local rows cannot contaminate a gate verdict; otherwise returns rows, latest-run-per-file by default. Filter by filePath (substring), commitSha (prefix), runGroup, status, source, since. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'Greening a red gate or triaging CI: find the ACTUAL failing test files at a commit/run instead of guessing or re-running blind. rollup:"commit" answers "is this sha green" in one call.',
    notWhen:
      'To decide whether a red is a known FLAKE rather than your change, use testing:flakiness (cross-run flip rate — same table, different question). To RUN tests use testing:run. For "is my change live/what is blocking it" use dev:pipeline_position.',
    chaining:
      'rollup:"commit" to find the red sha (CI rows by default; pass source:"local" or source:"admin-ui" for another writer) → rows with that commitSha + status:["fail","error"] for the failing files and their output tails → testing:flakiness on a file before assuming the red is yours.',
    // Response docs live HERE, not in description/when — those are
    // prompt-weight budgeted (the guard refused the P-002 edit on routines:list).
    returns: [
      'Rows: { filePath, status, framework, startedAt, finishedAt, durationMs, commitSha, runGroupId, source, branch, outputTail, loopLagP95Ms, rssMb, saturationSuspect, worktreeDirty, isScratchConfig }. outputTail is populated only for fail/error rows and is truncated.',
      'Rollup rows: { key, total, failed, failedFiles, files, firstStart, lastFinish } grouped by commit_sha or run_group_id. By default each group uses its latest result per file, matching the row-listing view; pass latestPerFile:false to include historical attempts. The response also reports the effective source filter; commit rollups default to source:"ci".',
      '`count` = rows returned; `total` = rows matching the filter independent of `limit`; `truncatedByLimit` says whether they differ, so a capped list is never read as a total.',
      'latestPerFile (default true, or false when you name a filePath) collapses to the most recent run per file — without it a file that failed an hour ago and has passed since still lists as failing.',
      '`saturationSuspect` = this row was recorded while host event-loop p95 was past the critical band, so it is NOT reliable evidence of a genuine red — re-run before chasing it. NULL lag is not suspect (it means no monitor was running, not that the host was calm).',
      'SCOPE: no workspace/harness predicate is applied by default, deliberately. CI/gate rows carry NULL workspace_id/harness_slug (the CI reporter derives them from env vars CI never sets), so scoping by workspace silently excludes every CI row and reads as a clean "no failures" (EI-19324633485547042). Pass `workspace` only for per-hive Tests-tab rows, knowing it excludes CI.',
      "Status values are 'pass'/'fail'/'skip'/'cancelled'/'error'/'running' — never 'passed'/'failed'.",
    ].join(' '),
    seeAlso: [
      'testing:flakiness (is this red a known flake — cross-run flip rate)',
      'testing:run (actually run test files)',
      'dev:pipeline_position (is my change live / what is blocking it)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    filePath: z
      .string()
      .max(400)
      .optional()
      .describe('Match test file path as a literal SUBSTRING (a memorable fragment is fine); LIKE metacharacters are treated literally.'),
    commitSha: z.string().max(80).optional().describe('Match commit sha as a PREFIX — a short sha works.'),
    runGroup: z.string().max(200).optional().describe('Exact run_group_id (one suite execution).'),
    status: z
      .array(z.enum(['pass', 'fail', 'skip', 'cancelled', 'error', 'running']))
      .min(1)
      .optional()
      .describe("Statuses to include. The RED set is ['fail','error'] — 'error' is a red too."),
    source: z
      .enum(['ci', 'local', 'admin-ui'])
      .optional()
      .describe('Which writer produced the row. Use "ci" for gate/CI triage.'),
    since: z.string().max(64).optional().describe('Only runs started at/after this ISO-8601 timestamp.'),
    sinceHours: z
      .number()
      .min(0.1)
      .max(2160)
      .optional()
      .describe('Relative window: only runs started within the last N hours. Ignored when `since` is given.'),
    workspace: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Filter to one workspace_id. WARNING: excludes every CI/gate row (those are NULL by design) — omit for CI triage.',
      ),
    rollup: z
      .enum(['commit', 'runGroup'])
      .optional()
      .describe('Aggregate instead of listing rows: group by commit_sha or run_group_id.'),
    latestPerFile: z
      .boolean()
      .optional()
      .describe('Collapse to the most recent run per file. Defaults true, or false when `filePath` is given.'),
    limit: z.number().int().min(1).max(200).optional().describe(`Max rows (default ${DEFAULT_LIMIT}).`),
  }),
  async handler(args: {
    filePath?: string;
    commitSha?: string;
    runGroup?: string;
    status?: Array<'pass' | 'fail' | 'skip' | 'cancelled' | 'error' | 'running'>;
    source?: 'ci' | 'local' | 'admin-ui';
    since?: string;
    sinceHours?: number;
    workspace?: string;
    rollup?: 'commit' | 'runGroup';
    latestPerFile?: boolean;
    limit?: number;
  }) {
    const { sql } = getOrgPg();
    const limit = args.limit ?? DEFAULT_LIMIT;
    const pathLike = args.filePath ? toPathPattern(args.filePath) : null;
    const shaLike = args.commitSha ? toShaPattern(args.commitSha) : null;
    const runGroup = args.runGroup ?? null;
    const source = defaultRollupSource(args.rollup, args.source);
    const workspace = args.workspace ?? null;
    const statuses = args.status ?? null;
    const sinceTs =
      args.since ??
      (args.sinceHours ? new Date(Date.now() - args.sinceHours * 3_600_000).toISOString() : null);
    // Naming a file means you want THAT FILE'S HISTORY; asking broadly means
    // you want the current picture, where a stale red would mislead.
    const latestPerFile = args.latestPerFile ?? args.filePath === undefined;

    const where = sql`
       WHERE (${pathLike}::text IS NULL OR file_path ILIKE ${pathLike} ESCAPE '\\')
         AND (${shaLike}::text IS NULL OR commit_sha ILIKE ${shaLike})
         AND (${runGroup}::text IS NULL OR run_group_id = ${runGroup})
         AND (${source}::text IS NULL OR source = ${source})
         AND (${workspace}::text IS NULL OR workspace_id = ${workspace})
         AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
         AND (${sinceTs}::timestamptz IS NULL OR started_at >= ${sinceTs}::timestamptz)`;

    if (args.rollup) {
      const keyCol = args.rollup === 'commit' ? sql`commit_sha` : sql`run_group_id`;
      // A gate retry writes a second row for the same file/commit/run group. The
      // row-listing path already hides the superseded attempt; applying the same
      // collapse here is what makes "is this sha green" answer the current
      // outcome instead of counting a historical fail forever. Keep an explicit
      // latestPerFile:false escape hatch for callers that intentionally want the
      // raw attempt history in an aggregate.
      const rollupRows = latestPerFile
        ? sql`SELECT DISTINCT ON (${keyCol}, file_path) *
                FROM filtered
               ORDER BY ${keyCol}, file_path, finished_at DESC NULLS LAST, id DESC`
        : sql`SELECT * FROM filtered`;
      const rows = await sql<
        Array<{
          key: string | null;
          total: string;
          failed: string;
          failed_files: string;
          files: string;
          // timestamptz reads back as a STRING on this client; `Date` here was an
          // assertion about the driver, not a check of it. Route through toIso.
          first_start: string | Date | null;
          last_finish: string | Date | null;
          group_count: string;
        }>
      >`
        WITH filtered AS (
          SELECT * FROM harness_shared.test_runs
          ${where}
        ), latest_rows AS (
          ${rollupRows}
        ), grouped AS (
          SELECT ${keyCol} AS key,
                 count(*)::text AS total,
                 count(*) FILTER (WHERE status = ANY(${RED_STATUSES as unknown as string[]}::text[]))::text AS failed,
                 count(DISTINCT file_path) FILTER (WHERE status = ANY(${RED_STATUSES as unknown as string[]}::text[]))::text AS failed_files,
                 count(DISTINCT file_path)::text AS files,
                 min(started_at) AS first_start,
                 max(finished_at) AS last_finish
            FROM latest_rows
           GROUP BY 1
        )
        SELECT g.*, (SELECT count(*) FROM grouped)::text AS group_count
          FROM grouped g
         ORDER BY g.last_finish DESC NULLS LAST
         LIMIT ${limit}`;

      const total = rows.length > 0 ? Number(rows[0]!.group_count) : 0;
      return {
        data: {
          rollup: args.rollup,
          source,
          latestPerFile,
          count: rows.length,
          total,
          truncatedByLimit: total > rows.length,
          groups: rows.map((r) => ({
            key: r.key,
            total: Number(r.total),
            failed: Number(r.failed),
            failedFiles: Number(r.failed_files),
            files: Number(r.files),
            firstStart: iso(r.first_start),
            lastFinish: iso(r.last_finish),
          })),
        },
      };
    }

    const picked = latestPerFile
      ? sql`SELECT DISTINCT ON (file_path) * FROM filtered ORDER BY file_path, finished_at DESC NULLS LAST, id DESC`
      : sql`SELECT * FROM filtered`;

    const rows = await sql<
      Array<{
        file_path: string;
        status: string;
        framework: string;
        duration_ms: string | null;
        started_at: string | Date;
        finished_at: string | Date | null;
        output_tail: string | null;
        run_group_id: string | null;
        source: string;
        branch: string | null;
        commit_sha: string | null;
        loop_lag_p95_ms: number | null;
        rss_mb: number | null;
        worktree_dirty: boolean;
        is_scratch_config: boolean;
        total: string;
      }>
    >`
      WITH filtered AS (
        SELECT * FROM harness_shared.test_runs
        ${where}
      ), picked AS (
        ${picked}
      )
      SELECT p.file_path, p.status, p.framework, p.duration_ms::text, p.started_at, p.finished_at,
             CASE WHEN p.status = ANY(${RED_STATUSES as unknown as string[]}::text[])
                  THEN left(p.output_tail, ${OUTPUT_TAIL_CHARS}) END AS output_tail,
             p.run_group_id, p.source, p.branch, p.commit_sha,
             p.loop_lag_p95_ms, p.rss_mb, p.worktree_dirty, p.is_scratch_config,
             (SELECT count(*) FROM picked)::text AS total
        FROM picked p
       ORDER BY p.finished_at DESC NULLS LAST, p.started_at DESC
       LIMIT ${limit}`;

    const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
    return {
      data: {
        count: rows.length,
        total,
        truncatedByLimit: total > rows.length,
        latestPerFile,
        runs: rows.map((r) => ({
          filePath: r.file_path,
          status: r.status,
          framework: r.framework,
          startedAt: iso(r.started_at),
          finishedAt: iso(r.finished_at),
          durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
          commitSha: r.commit_sha,
          runGroupId: r.run_group_id,
          source: r.source,
          branch: r.branch,
          outputTail: r.output_tail,
          loopLagP95Ms: r.loop_lag_p95_ms,
          rssMb: r.rss_mb,
          saturationSuspect: isSaturationSuspect(r.loop_lag_p95_ms),
          worktreeDirty: r.worktree_dirty,
          isScratchConfig: r.is_scratch_config,
        })),
      },
    };
  },
});
