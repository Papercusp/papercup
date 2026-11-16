/**
 * Postgres reader for the plan-portfolio census (plan-portfolio-flow-and-weight-2026-11-13 P-001).
 *
 * It hands the census every plan row of one workspace, in (harness_slug, plan_slug) byte order,
 * a batch at a time. It applies NO population filter: which plans a measure counts is decided
 * once, in census.ts, from the manifest entry. Byte order (COLLATE "C") is what makes the
 * keyset cursor agree with the code-unit comparison census.ts uses to refuse a repeated row.
 */
import { getOrgPg } from '@papercusp/db-org';
import { BAR_READINESS_NOW_MARK } from '../agent-tools/plans/plan-now-markers';
import type { CensusKey, CensusPlanItemRow, CensusPlanRow, CensusPlanStore, CensusWorkItemRow } from './census';

type SqlLike = { query(strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown> }['query'];

function iso(value: Date | string | null): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return new Date(Number.isFinite(parsed) ? parsed : 0).toISOString();
}

function planItems(value: unknown): CensusPlanItemRow[] {
  if (!Array.isArray(value)) return [];
  const out: CensusPlanItemRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { id?: unknown; status?: unknown; blockedBy?: unknown };
    if (typeof item.id !== 'string' || typeof item.status !== 'string') continue;
    out.push({
      id: item.id,
      status: item.status,
      blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.filter((id): id is string => typeof id === 'string') : [],
    });
  }
  return out;
}

export function createPgCensusPlanStore(input: { workspaceId: string; sql?: SqlLike }): CensusPlanStore {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) throw new Error('census_store_workspace_required');
  const sql = input.sql ?? (getOrgPg().sql as unknown as SqlLike);
  return {
    async readPlans({ after, limit }: { after: CensusKey | null; limit: number }): Promise<CensusPlanRow[]> {
      const plans = (await sql`
        SELECT harness_slug, plan_slug, version, status, archived, template, created_at, updated_at,
               char_length(coalesce(content, '')) AS content_chars,
               CASE WHEN jsonb_typeof(decisions) = 'array' THEN jsonb_array_length(decisions) ELSE 0 END AS decision_count,
               position(${BAR_READINESS_NOW_MARK} in coalesce(content, '')) > 0 AS has_readiness_block,
               embedding IS NOT NULL AS has_embedding,
               items
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId}
           AND (${after?.harnessSlug ?? null}::text IS NULL
                OR (harness_slug COLLATE "C", plan_slug COLLATE "C")
                   > (${after?.harnessSlug ?? null}::text COLLATE "C", ${after?.planSlug ?? null}::text COLLATE "C"))
         ORDER BY harness_slug COLLATE "C", plan_slug COLLATE "C"
         LIMIT ${limit}
      `) as Array<{
        harness_slug: string; plan_slug: string; version: number | string | null;
        status: string | null; archived: boolean | null; template: string | null;
        created_at: Date | string | null; updated_at: Date | string | null; content_chars: number | string;
        decision_count: number | string; has_readiness_block: boolean | null; has_embedding: boolean; items: unknown;
      }>;
      if (plans.length === 0) return [];
      const slugs = [...new Set(plans.map((plan) => plan.plan_slug))];
      const workItems = (await sql`
        SELECT harness_slug, plan_slug, plan_line_id, status, taken_by IS NOT NULL AS held,
               coalesce(claim_hold, false) AS claim_hold, payload->>'claim_hold_by' AS claim_hold_by, lane
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND plan_line_id IS NOT NULL
           AND plan_slug = ANY(${slugs}::text[])
      `) as Array<{
        harness_slug: string; plan_slug: string; plan_line_id: string; status: string | null; held: boolean;
        claim_hold: boolean; claim_hold_by: string | null; lane: string | null;
      }>;
      const byPlan = new Map<string, CensusWorkItemRow[]>();
      for (const row of workItems) {
        const key = `${row.harness_slug}\u0000${row.plan_slug}`;
        const list = byPlan.get(key) ?? [];
        list.push({ planLineId: row.plan_line_id, status: row.status ?? '', held: row.held === true,
          claimHold: row.claim_hold === true, claimHoldBy: row.claim_hold_by, lane: row.lane });
        byPlan.set(key, list);
      }
      return plans.map((plan) => ({
        harnessSlug: plan.harness_slug,
        planSlug: plan.plan_slug,
        revision: plan.version === null ? null : String(plan.version),
        status: plan.status ?? '',
        archived: plan.archived === true,
        template: plan.template,
        createdAt: iso(plan.created_at),
        updatedAt: iso(plan.updated_at),
        contentChars: Number(plan.content_chars),
        decisionCount: Number(plan.decision_count),
        hasReadinessBlock: plan.has_readiness_block === true,
        hasEmbedding: plan.has_embedding === true,
        items: planItems(plan.items),
        workItems: byPlan.get(`${plan.harness_slug}\u0000${plan.plan_slug}`) ?? [],
      }));
    },

    async countPlansAfter(after: CensusKey | null): Promise<number> {
      const rows = (await sql`
        SELECT count(*) AS n
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId}
           AND (${after?.harnessSlug ?? null}::text IS NULL
                OR (harness_slug COLLATE "C", plan_slug COLLATE "C")
                   > (${after?.harnessSlug ?? null}::text COLLATE "C", ${after?.planSlug ?? null}::text COLLATE "C"))
      `) as Array<{ n: number | string }>;
      return Number(rows[0]?.n ?? 0);
    },

    async readNearTwinPairs({ harnessSlug, planSlugs, minSimilarity }: {
      harnessSlug: string; planSlugs: string[]; minSimilarity: number;
    }): Promise<Array<{ a: string; b: string; similarity: number }>> {
      if (planSlugs.length < 2) return [];
      const rows = (await sql`
        SELECT a.plan_slug AS a, b.plan_slug AS b, 1 - (a.embedding <=> b.embedding) AS similarity
          FROM harness_shared.harness_plans a
          JOIN harness_shared.harness_plans b
            ON b.workspace_id = a.workspace_id
           AND b.harness_slug = a.harness_slug
           AND b.plan_slug > a.plan_slug
           AND b.embedding_profile IS NOT DISTINCT FROM a.embedding_profile
         WHERE a.workspace_id = ${workspaceId}
           AND a.harness_slug = ${harnessSlug}
           AND a.plan_slug = ANY(${planSlugs}::text[])
           AND b.plan_slug = ANY(${planSlugs}::text[])
           AND a.embedding IS NOT NULL
           AND b.embedding IS NOT NULL
           AND 1 - (a.embedding <=> b.embedding) >= ${minSimilarity}
      `) as Array<{ a: string; b: string; similarity: number | string }>;
      return rows.map((row) => ({ a: row.a, b: row.b, similarity: Number(row.similarity) }));
    },
  };
}
