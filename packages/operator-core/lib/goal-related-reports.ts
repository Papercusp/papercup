import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { reportsLibraryDisabled } from './agent-tools/reports/_shared';
import { boundedOrgTxn } from './pg-bounded-txn';
import { visibleTo, type ReportViewer } from './report-library';
import { reportSourceVersion } from './memory/temporal-render';

/** This limits the inline view. The returned call advances through the full visible set. */
export const GOAL_REPORT_PAGE_SIZE = 3;

/** The replacement launch acquires its actual recipient after the history compiler
 * rendered the draft. Keep its original destination-pot visibility ceiling. */
export async function bindGoalReportKickoff(text: string, goalId: string, recipient: GoalReportRecipient) {
  const { GOAL_HISTORY_CONTEXT_HEADING } = await import('./agent-tools/goals/start');
  const lines = text.split('\n');
  const heading = lines.indexOf(GOAL_HISTORY_CONTEXT_HEADING);
  if (heading < 0) return text;
  let history;
  try { history = JSON.parse(lines[heading + 1]); } catch { return text; }
  if (history?.recovery?.args?.id !== goalId || !history.relatedReports) return text;
  const { getOrgPg } = await import('@papercusp/db-org');
  history.relatedReports = await readGoalReportPage(getOrgPg().sql, goalId, recipient);
  lines[heading + 1] = JSON.stringify(history);
  return lines.join('\n');
}

export interface GoalReportRecipient {
  workspaceId: string;
  viewer: Pick<ReportViewer, 'ownerId' | 'potSlug'>;
  /** Only automatic deliveries supply their actual destination. Explicit reads always show the full inventory. */
  deliveryOwnerId?: string;
}

const cursorSchema = z.object({
  scope: z.string(),
  owner: z.string().nullable(),
  population: z.string(),
  priority: z.number().int(),
  publishedAt: z.string().datetime({ offset: true }),
  reportId: z.string().min(1),
}).strict();

interface ReportEvidenceRow {
  population: string;
  total: string;
  remaining: string | null;
  report_id: string | null;
  title: string;
  finding: string;
  finding_chars: number;
  body_md: string;
  retired_at: Date | string | null;
  epoch: number;
  published_at: string;
  priority: number;
  relationship: string;
  source_ref: string;
  disposition: 'current' | 'superseded' | 'retired';
}

function recovery(goalId: string, reportCursor?: string) {
  return { tool: 'goals:get' as const, args: { id: goalId, detail: 'full' as const, ...(reportCursor ? { reportCursor } : {}) } };
}

function reportEntry(row: ReportEvidenceRow, reportId: string) {
  return { reportId, title: row.title, finding: row.finding, findingTruncated: row.finding_chars > 320,
    publishedAt: row.published_at, relationship: row.relationship, sourceRef: row.source_ref,
    disposition: row.disposition, read: { tool: 'reports:get' as const, args: { id: reportId } } };
}

export type GoalReportPage = {
  status: 'available' | 'empty' | 'in-context'; entries: ReturnType<typeof reportEntry>[];
  total: number; omitted: number; next: ReturnType<typeof recovery> | null; deliveryToken?: string;
} | ({
  status: 'unavailable' | 'invalid-cursor' | 'changed'; recovery: ReturnType<typeof recovery>;
} | { status: 'disabled' }) & { entries?: never; total?: never; omitted?: never; next?: never; deliveryToken?: never };

export async function readGoalReportPage(
  sql: Sql, goalId: string, recipient: GoalReportRecipient, reportCursor?: string,
): Promise<GoalReportPage> {
  const { workspaceId, viewer, deliveryOwnerId } = recipient;
  const restart = recovery(goalId);
  const scope = createHash('sha256').update(JSON.stringify([workspaceId, goalId, viewer.potSlug ?? null])).digest('hex');
  let after: z.infer<typeof cursorSchema> | null = null;
  if (reportCursor !== undefined) {
    try {
      after = cursorSchema.parse(JSON.parse(Buffer.from(reportCursor, 'base64url').toString('utf8')));
    } catch {
      return { status: 'invalid-cursor' as const, recovery: restart };
    }
    if (after.scope !== scope || (after.owner !== null && after.owner !== viewer.ownerId)) {
      return { status: 'invalid-cursor' as const, recovery: restart };
    }
  }

  try {
    if (await reportsLibraryDisabled()) return { status: 'disabled' as const };
    const rows = await boundedOrgTxn(async tx => {
      // A fresh replacement's owner ID may be minted by the launch service. Its initial
      // page uses the destination pot only. Continue with that same visibility ceiling.
      const reader = { potSlug: viewer.potSlug, ownerId: after ? after.owner : viewer.ownerId };
      const gate = visibleTo(tx, reader);
      return tx<ReportEvidenceRow[]>`
        WITH plans AS (
          SELECT plan_slug, harness_slug, content FROM harness_shared.harness_plans
          WHERE workspace_id = ${workspaceId} AND goal_id = ${goalId} AND archived IS NOT TRUE
        ), items AS (
          SELECT w.feature_id, w.harness_slug, w.summary, w.notes, w.payload, w.terminal_completion_ref
          FROM harness_shared.work_items w
          WHERE w.workspace_id = ${workspaceId} AND w.lane IS DISTINCT FROM 'observation'
            AND (w.goal_id = ${goalId} OR EXISTS (SELECT 1 FROM plans p
              WHERE p.plan_slug = w.source_plan_slug AND p.harness_slug = w.harness_slug))
        ), sources AS (
          SELECT 'work_item' AS kind, w.feature_id AS ref, 10 AS weight,
            concat_ws(' ', w.summary, w.notes, w.payload::text, w.terminal_completion_ref, c.note) AS content
          FROM items w LEFT JOIN harness_shared.carry_notes c
            ON c.workspace_id = ${workspaceId}
            AND c.scope = 'workitem:' || coalesce(nullif(w.harness_slug, ''), '*') || ':' || w.feature_id
          UNION ALL SELECT 'plan', plan_slug, 20, content FROM plans
          UNION ALL SELECT 'goal', id, 30, concat_ws(' ', body, metadata::text) FROM harness_shared.goals
            WHERE workspace_id = ${workspaceId} AND id = ${goalId}
        ), citations AS (
          SELECT DISTINCT s.kind, s.ref, s.weight, m.id[1] AS report_id
          FROM sources s CROSS JOIN LATERAL regexp_matches(s.content, '[[:<:]]rpt_[A-Za-z0-9_-]+', 'g') AS m(id)
        ), visible AS NOT MATERIALIZED (
          SELECT * FROM harness_shared.report_library WHERE workspace_id = ${workspaceId} AND ${gate}
        ), pins AS (
          SELECT c.*, r.lineage_id FROM citations c JOIN visible r USING (report_id)
        ), matches AS (
          SELECT p.report_id, 0 AS weight, 'cited by ' || p.kind AS relationship, p.ref, true AS pinned FROM pins p
          UNION ALL
          SELECT r.report_id, 1, 'current edition of report cited by ' || p.kind, p.ref, false
            FROM pins p JOIN visible r ON r.lineage_id = p.lineage_id AND r.report_id <> p.report_id
          UNION ALL
          SELECT r.report_id, s.weight, 'attached to ' || s.kind, s.ref, false
            FROM sources s JOIN visible r ON r.subject_kind = s.kind AND r.subject_ref = s.ref
        ), eligible AS (
          SELECT DISTINCT ON (r.report_id) r.report_id, r.published_at,
            m.weight + CASE WHEN r.kind = 'status-digest' THEN 2 ELSE 0 END AS priority,
            m.relationship, m.ref, CASE WHEN r.retired_at IS NOT NULL THEN 'retired'
              WHEN edition.replaced THEN 'superseded' ELSE 'current' END AS disposition
          FROM matches m JOIN visible r USING (report_id)
          CROSS JOIN LATERAL (SELECT EXISTS (
            SELECT 1 FROM harness_shared.report_library newer
            WHERE newer.workspace_id = r.workspace_id AND newer.lineage_id = r.lineage_id
              AND (newer.published_at, newer.report_id) > (r.published_at, r.report_id)
          ) AS replaced) edition
          WHERE m.pinned OR (r.retired_at IS NULL AND NOT edition.replaced)
          ORDER BY r.report_id, m.weight, m.relationship, m.ref
        ), inventory AS (
          SELECT count(*) AS total, md5(coalesce(string_agg(
            jsonb_build_array(report_id, priority, relationship, ref, disposition)::text,
            E'\n' ORDER BY report_id), '')) AS population FROM eligible
        ), recipient_epoch AS (
          SELECT ${deliveryOwnerId ? tx`coalesce((SELECT epoch FROM harness_shared.memory_session_epochs
            WHERE session_id = ${deliveryOwnerId}), 0)` : tx`0`} AS epoch
        ), page AS (
          SELECT e.*, count(*) OVER () AS remaining FROM eligible e
          WHERE true
          ${after ? tx`AND (priority > ${after.priority} OR (priority = ${after.priority}
            AND (published_at, report_id) < (${after.publishedAt}::timestamptz, ${after.reportId})))` : tx``}
          ${deliveryOwnerId ? tx`AND NOT EXISTS (
            SELECT 1 FROM harness_shared.corpus_session_surfaced s
            WHERE s.session_id = ${deliveryOwnerId} AND s.epoch = (SELECT epoch FROM recipient_epoch)
              AND s.ref = 'report:' || e.report_id AND s.source_fingerprint = s.source_version->>'fingerprint'
              AND s.source_version->>'namespace' = ${'corpus:report:' + workspaceId}
              AND s.source_version->>'revision' = e.report_id AND s.source_version->'validity'->>'status' =
                CASE WHEN e.disposition = 'retired' THEN 'retracted' ELSE e.disposition END
          )` : tx``}
          ORDER BY priority, published_at DESC, report_id DESC LIMIT ${GOAL_REPORT_PAGE_SIZE}
        )
        SELECT i.population, i.total, p.remaining, p.report_id, r.title, (SELECT epoch FROM recipient_epoch) AS epoch,
          ${deliveryOwnerId ? tx`r.body_md` : tx`NULL::text`} AS body_md, r.retired_at,
          left(coalesce(nullif(r.summary, ''), r.body_md), 320) AS finding,
          length(coalesce(nullif(r.summary, ''), r.body_md)) AS finding_chars,
          to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at,
          p.priority, p.relationship, p.ref AS source_ref, p.disposition
        FROM inventory i LEFT JOIN page p ON true LEFT JOIN visible r ON r.report_id = p.report_id
        ORDER BY p.priority, p.published_at DESC, p.report_id DESC`;
    }, { client: sql, readOnly: true, statementTimeoutMs: 2_500 });

    const { population, total, remaining } = rows[0];
    if (after && after.population !== population) return { status: 'changed' as const, recovery: restart };
    const entries = rows.flatMap(row => row.report_id ? [reportEntry(row, row.report_id)] : []);
    const omitted = Number(remaining ?? 0) - entries.length;
    const last = rows.at(-1)!;
    const next = omitted > 0 ? recovery(goalId, Buffer.from(JSON.stringify({
      scope, owner: after ? after.owner : viewer.ownerId ?? null, population,
      priority: last.priority, publishedAt: last.published_at, reportId: last.report_id,
    })).toString('base64url')) : null;
    const page = { status: entries.length ? 'available' as const :
      deliveryOwnerId && Number(total) > 0 ? 'in-context' as const : 'empty' as const,
      entries, total: Number(total), omitted, next };
    if (!deliveryOwnerId || !entries.length) return page;
    try {
      const { memoryFragmentOffer, stageMemoryEmission } = await import('./memory/session-epoch-ledger');
      const versions = entries.map((entry, i) => reportSourceVersion(workspaceId, entry.reportId, entry.title,
        rows[i].body_md, entry.publishedAt, entry.disposition === 'retired' ? 'retracted' : entry.disposition, rows[i].retired_at));
      const { revalidateReportSourceVersions } = await import('./agent-tools/search/report-source');
      let refreshed: Promise<Map<string, typeof versions[number]>> | undefined;
      const offers = entries.map((entry, i) => memoryFragmentOffer('corpus', versions[i].ref, rows[i].epoch,
        'goal-brief', JSON.stringify(entry), versions[i], async signal => {
          refreshed ??= revalidateReportSourceVersions({ sql, workspaceId, viewer, audience: {}, previous: versions, signal })
            .then(current => new Map(current.map(v => [v.ref, v])));
          return (await refreshed).get(versions[i].ref) ?? null;
        }));
      const deliveryToken = randomUUID();
      await stageMemoryEmission(sql, deliveryOwnerId, deliveryToken, offers);
      return { ...page, deliveryToken };
    } catch {
      // The brief still delivers its findings. Without a staged token a later wake can replay them.
      return page;
    }
  } catch {
    return { status: 'unavailable' as const, recovery: recovery(goalId, reportCursor) };
  }
}
