/** R-4: propose completion citations from the existing edit and commit attribution ledgers. */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { PlanItemStatus } from '../../plan-audits';

export interface AttributedAuditFile {
  itemId: string;
  workItemId: string;
  path: string;
  source: 'edit' | 'commit';
}

const ROW_LIMIT = 5000;

export async function readAttributedAuditFiles(input: {
  workspaceId: string; harnessSlug: string; planSlug: string; itemIds: string[];
}): Promise<AttributedAuditFile[]> {
  const { sql } = getOrgPg();
  const workspaces = [...new Set([input.workspaceId, DEFAULT_COORD_WORKSPACE])];
  return sql<AttributedAuditFile[]>`
    WITH linked AS (
      SELECT wi.feature_id AS work_item_id, x.item_id
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[])) x(item_id)
       WHERE wi.workspace_id = ANY(${workspaces}::text[])
         AND wi.harness_slug = ${input.harnessSlug} AND wi.source_plan_slug = ${input.planSlug}
      UNION
      SELECT feature_id, payload->'plan_item'->>'item_id'
        FROM harness_shared.work_items
       WHERE workspace_id = ANY(${workspaces}::text[])
         AND harness_slug = ${input.harnessSlug}
         AND payload->'plan_item'->>'plan_slug' = ${input.planSlug}
      UNION
      SELECT wi.feature_id, split_part(l.dst_ref, '#', 2)
        FROM harness_shared.coord_links l
        JOIN harness_shared.work_items wi ON wi.workspace_id = l.workspace_id
         AND wi.harness_slug = ${input.harnessSlug}
         AND ((l.src_kind = 'issue' AND wi.feature_id = l.src_ref)
           OR (l.src_kind = 'feature' AND l.src_ref = wi.harness_slug || '#' || wi.feature_id))
       WHERE l.workspace_id = ANY(${workspaces}::text[])
         AND l.rel = ANY(${['implements', 'relates']}::text[])
         AND l.dst_kind = 'plan_item' AND split_part(l.dst_ref, '#', 1) = ${input.planSlug}
    ), files AS (
      SELECT work_item_id, file AS path, 'edit' AS source
        FROM harness_shared.edit_attribution_ledger
       WHERE workspace_id = ANY(${workspaces}::text[])
         AND harness_slug = ${input.harnessSlug}
      UNION
      SELECT work_item_id,
             CASE WHEN repo = 'superproject' THEN file ELSE repo || '/' || file END,
             'commit'
        FROM harness_shared.git_sync_commit_attribution
       WHERE workspace_id = ANY(${workspaces}::text[])
         AND harness_slug = ${input.harnessSlug}
    )
    SELECT DISTINCT l.item_id AS "itemId", l.work_item_id AS "workItemId", f.path, f.source
      FROM linked l JOIN files f ON f.work_item_id = l.work_item_id
     WHERE l.item_id = ANY(${input.itemIds}::text[])
     ORDER BY "itemId", f.path, "workItemId", f.source
     LIMIT ${ROW_LIMIT}`;
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.startsWith('~') &&
    !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export async function proposeAuditCitations(
  input: { workspaceId: string; harnessSlug: string; planSlug: string; items: readonly PlanItemStatus[] },
  deps: {
    readFiles?: typeof readAttributedAuditFiles;
    blobSha: (path: string) => string | null | Promise<string | null>;
  },
) {
  const done = input.items.filter(item => item.status === 'done');
  const doneIds = new Set(done.map(item => item.itemId));
  const rows = done.length ? await (deps.readFiles ?? readAttributedAuditFiles)({
    ...input, itemIds: [...doneIds],
  }) : [];
  const measured = new Map<string, string | null>();
  const proposals = [];
  const unresolved: Array<{ itemId: string; path: string; reason: string }> = [];
  for (const item of done) {
    const paths = new Map<string, AttributedAuditFile[]>();
    for (const row of rows) {
      if (row.itemId !== item.itemId || !doneIds.has(row.itemId)) continue;
      if (!safePath(row.path)) {
        unresolved.push({ itemId: item.itemId, path: row.path, reason: 'unsafe attribution path' });
        continue;
      }
      paths.set(row.path, [...(paths.get(row.path) ?? []), row]);
    }
    const citations = [];
    for (const [path, attributed] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
      if (!measured.has(path)) measured.set(path, await deps.blobSha(path));
      const blobSha = measured.get(path);
      if (!blobSha) {
        unresolved.push({ itemId: item.itemId, path, reason: 'current file blob could not be measured' });
        continue;
      }
      citations.push({ kind: /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ? 'test' as const : 'code' as const,
        path, blobSha, workItemIds: [...new Set(attributed.map(row => row.workItemId))].sort(),
        sources: [...new Set(attributed.map(row => row.source))].sort() });
    }
    proposals.push({ itemId: item.itemId, citations });
  }
  return { proposals, unresolved, truncatedByLimit: rows.length >= ROW_LIMIT,
    note: 'Proposals identify attributed files and their measured bytes; review the implementation before recording a verdict.' };
}
