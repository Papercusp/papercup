/**
 * corpus-digest-deps.ts — the production WIRING of the state-of-Hive digest
 * readers to real sources (the change feed, the improvement queue, PG spend +
 * audit + plans).
 *
 * Mirrors curation/change-feed-deps.ts: inject minimal reader contracts so the
 * core `corpus-digest` synthesis stays pure + testable; this file wires the
 * real queries. DERIVED, not logged — every reader queries a completion / audit
 * SOURCE, so the digest regenerates from the live corpus each tick.
 *
 * Reuse over rebuild (CLAUDE.md): completions come from the existing change feed
 * (gatherCompletions), friction from the existing improvement loader
 * (readImprovementItems). Only the spend / reverts / deferrals readers are new
 * PG queries, and even those hit established tables (agent_usage_samples,
 * feature_audit_consolidated, harness_plans).
 *
 * Schema notes (verified live against :5432, 2026-06-08):
 *  - agent_usage_samples: cost_usd double, input/output_tokens bigint(as string),
 *    harness_slug/role nullable, ts bigint epoch-ms (migrations 161/170).
 *  - feature_audit_consolidated: field/old_value/new_value/actor text, ts bigint;
 *    status values are JSON-quoted strings ("passed") in the text columns —
 *    unquoted here before the core ranks them (migration 118).
 *  - harness_plans.items / .decisions: jsonb arrays of parsed plan items /
 *    decisions (migration 128); items carry {id,text,status}, decisions {id,title,body}.
 */

import { getOrgPg } from '@papercusp/db-org';
import { gatherCompletions, type ChangeFeedEntry } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import { readImprovementItems } from '../harness/improvements/read-items';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { revertWeight, type DeferralRecord, type RevertRecord, type SpendRecord, type StateOfHiveReaders } from './corpus-digest';

/** ISO timestamp from an epoch-ms bigint column (postgres-js returns bigint as string). */
function epochMsToIso(v: string | number | null): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return new Date(Number.isFinite(n) ? n : 0).toISOString();
}

/** Strip the JSON quoting a status carries in feature_audit's text columns
 *  ("passed" → passed). Tolerates already-unquoted values + nulls. */
function unquoteStatus(v: string | null): string {
  if (!v) return '';
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Reverts: status regressions from feature_audit (undone work). Pulls recent
 *  status transitions; the core's revertWeight decides which are regressions. */
async function fetchReverts(): Promise<RevertRecord[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    { feature_id: string; harness_slug: string | null; old_value: string | null; new_value: string | null; actor: string | null; ts: string }[]
  >`
    SELECT feature_id, harness_slug, old_value, new_value, actor, ts
      FROM harness_shared.feature_audit_consolidated
     WHERE field = 'status'
       AND old_value IS NOT NULL
       AND new_value IS NOT NULL
     ORDER BY ts DESC
     LIMIT 2000`;

  return rows
    .map((r) => ({
      workItemId: r.feature_id,
      harness: r.harness_slug ?? undefined,
      from: unquoteStatus(r.old_value),
      to: unquoteStatus(r.new_value),
      actor: r.actor,
      ts: epochMsToIso(r.ts),
    }))
    // Keep only genuine regressions — the core ranks; here we shrink the payload.
    .filter((r) => revertWeight(r.from, r.to) > 0);
}

/** Spend buckets: agent_usage_samples rolled up by (harness, role) — where
 *  time/tokens went. */
async function fetchSpend(): Promise<SpendRecord[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string | null; role: string | null; cost: string | null; input: string | null; output: string | null; runs: string }[]
  >`
    SELECT harness_slug,
           role,
           COALESCE(SUM(cost_usd), 0)       AS cost,
           COALESCE(SUM(input_tokens), 0)   AS input,
           COALESCE(SUM(output_tokens), 0)  AS output,
           COUNT(*)                          AS runs
      FROM harness_shared.agent_usage_samples
     GROUP BY harness_slug, role
     ORDER BY cost DESC NULLS LAST
     LIMIT 200`;

  return rows.map((r) => ({
    harness: r.harness_slug,
    role: r.role,
    costUsd: Number(r.cost ?? 0),
    inputTokens: Number(r.input ?? 0),
    outputTokens: Number(r.output ?? 0),
    runs: Number(r.runs ?? 0),
  }));
}

/** Deferrals: explicit plan-item punts (status blocked/needs-human) + decisions
 *  marked deferred. A normal dependency-blocked todo is NOT here (only explicit
 *  status). jsonb arrays guarded with COALESCE so a null column never errors. */
async function fetchDeferrals(): Promise<DeferralRecord[]> {
  const { sql } = getOrgPg();

  const items = await sql<
    { plan_slug: string; ref_id: string | null; status: string | null; text: string | null }[]
  >`
    SELECT p.plan_slug,
           i->>'id'     AS ref_id,
           i->>'status' AS status,
           i->>'text'   AS text
      FROM harness_shared.harness_plans p,
           jsonb_array_elements(COALESCE(p.items, '[]'::jsonb)) AS i
     WHERE i->>'status' IN ('blocked', 'needs-human')
     LIMIT 1000`;

  const decisions = await sql<
    { plan_slug: string; ref_id: string | null; title: string | null }[]
  >`
    SELECT p.plan_slug,
           d->>'id'    AS ref_id,
           d->>'title' AS title
      FROM harness_shared.harness_plans p,
           jsonb_array_elements(COALESCE(p.decisions, '[]'::jsonb)) AS d
     WHERE d->>'body' ~* '\mdeferr'
     LIMIT 1000`;

  const out: DeferralRecord[] = [];
  for (const r of items) {
    if (!r.ref_id || !r.text) continue;
    out.push({ planSlug: r.plan_slug, refId: r.ref_id, source: 'item', status: r.status ?? 'blocked', text: r.text });
  }
  for (const r of decisions) {
    if (!r.ref_id || !r.title) continue;
    out.push({ planSlug: r.plan_slug, refId: r.ref_id, source: 'decision', status: 'decision', text: r.title });
  }
  return out;
}

/**
 * Build the production StateOfHiveReaders. The core's synthesizeStateOfHive
 * wraps each reader defensively, so one bad query doesn't kill the whole digest.
 */
export function buildStateOfHiveReaders(): StateOfHiveReaders {
  return {
    async completions(): Promise<ChangeFeedEntry[]> {
      return gatherCompletions(buildChangeFeedReaders());
    },
    async reverts() {
      return fetchReverts();
    },
    async friction(): Promise<ImprovementCandidate[]> {
      return readImprovementItems();
    },
    async spend() {
      return fetchSpend();
    },
    async deferrals() {
      return fetchDeferrals();
    },
  };
}
