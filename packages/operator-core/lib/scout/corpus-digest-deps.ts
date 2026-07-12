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
import { readImprovementItems, readObservationItems } from '../harness/improvements/read-items';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { listRubrics } from '../rubrics';
import {
  revertWeight,
  type DeferralRecord,
  type ObservationRating,
  type RevertRecord,
  type RubricSummary,
  type SpendRecord,
  type StateOfHiveReaders,
  type StructuredObservationRecord,
} from './corpus-digest';

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
     WHERE d->>'body' ~* '\\mdeferr'
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
 * The structured-observation view P-001 (rubric-driven-observations D-003) surfaces
 * onto `ImprovementCandidate.observation`. Read STRUCTURALLY (not via the typed
 * field) so this module compiles + runs (yielding an empty rubric lane) BEFORE the
 * P-001 type edit lands, and auto-activates the instant it surfaces the field — the
 * "build against the draft contract" seam su-f8ee5 (P-001 owner) agreed. Once
 * `ImprovementCandidate.observation` is in-tree this cast can collapse to `c.observation`.
 */
interface ObservationView {
  sourceHive?: unknown;
  targetHive?: unknown;
  rubricRef?: unknown;
  ratings?: unknown;
}

function observationViewOf(c: ImprovementCandidate): ObservationView | undefined {
  const v = (c as { observation?: unknown }).observation;
  return v && typeof v === 'object' ? (v as ObservationView) : undefined;
}

/** Validate the `Record<criterionKey, { rating, evidence }>` ratings shape (D-003),
 *  dropping malformed entries. Returns undefined when nothing valid remains. */
function normalizeObservationRatings(raw: unknown): Record<string, ObservationRating> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, ObservationRating> = {};
  for (const [criterion, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!criterion || !val || typeof val !== 'object') continue;
    const { rating, evidence, suggestion } = val as {
      rating?: unknown;
      evidence?: unknown;
      suggestion?: unknown;
    };
    if (typeof rating !== 'string' || !rating.trim()) continue;
    out[criterion] = {
      rating,
      evidence: typeof evidence === 'string' ? evidence : '',
      // P-005 (blender-self-learning-2026-07-12): the grader's improvement idea
      // rides through to the rubric-rating pattern detail.
      ...(typeof suggestion === 'string' && suggestion.trim() ? { suggestion } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map an observation candidate → the clean StructuredObservationRecord the digest
 *  groups over. Returns undefined for FREE-TEXT observations (no rubricRef/ratings) —
 *  only RUBRIC-GRADED scorecards become records. The pure digest excludes those
 *  scorecard-shaped observations from friction mining so routine scorecard emitters
 *  do not dominate recurringFriction. */
function toStructuredObservation(c: ImprovementCandidate): StructuredObservationRecord | undefined {
  const view = observationViewOf(c);
  if (!view) return undefined;
  const rubricRef = typeof view.rubricRef === 'string' && view.rubricRef.trim() ? view.rubricRef : undefined;
  const ratings = normalizeObservationRatings(view.ratings);
  if (!rubricRef || !ratings) return undefined; // not a rubric-graded observation
  const sourceHive = typeof view.sourceHive === 'string' && view.sourceHive.trim() ? view.sourceHive : undefined;
  const targetHive = typeof view.targetHive === 'string' && view.targetHive.trim() ? view.targetHive : undefined;
  const tsMs = Date.parse(c.updatedAt ?? c.createdAt ?? '');
  return {
    id: c.id,
    title: c.title,
    rubricRef,
    ratings,
    ...(sourceHive ? { sourceHive } : {}),
    ...(targetHive ? { targetHive } : {}),
    ...(Number.isFinite(tsMs) ? { lastSeenMs: tsMs } : {}),
  };
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
      // Observations (turn-end-reflection-observations-2026-06-14 D-005) are PRE-IDEA
      // friction signals whose SOLE consumer is Scout. Union them into the friction
      // lane so a RECURRING observation gets clustered into a meta-pattern and can be
      // promoted to a real idea — the only path from observation → work. The pure
      // digest filters rubric-graded scorecards out of free-text friction mining;
      // those have the dedicated rubricRatings lane.
      const [improvements, observations] = await Promise.all([
        readImprovementItems(),
        readObservationItems(),
      ]);
      return [...improvements, ...observations];
    },
    async spend() {
      return fetchSpend();
    },
    async deferrals() {
      return fetchDeferrals();
    },
    async observations(): Promise<StructuredObservationRecord[]> {
      // Read the observation-lane topic and keep ONLY rubric-graded scorecards
      // (P-006). An independent read from friction()'s free-text union — a single
      // cheap topic query at Scout cadence — so the structured lane stays defensively
      // isolated. Empty until P-001 surfaces candidate.observation + a rubric is in use.
      const observations = await readObservationItems();
      const out: StructuredObservationRecord[] = [];
      for (const c of observations) {
        const record = toStructuredObservation(c);
        if (record) out.push(record);
      }
      return out;
    },
    async rubrics(): Promise<RubricSummary[]> {
      // ACTIVE rubrics only (P-008) — a proposed/retired rubric is not yet a
      // shared standard that "covers" a friction cluster. listRubrics reads the
      // canonical rubric source (P-006 plans∪table union; plans-only after P-007),
      // so this survives the P-007 table drop with no change here. Map the full
      // Rubric → the minimal coverage view the gap-check needs.
      const rubrics = await listRubrics({ status: 'active', limit: 500 });
      return rubrics.map((r) => ({
        rubricId: r.rubricId,
        characteristic: r.characteristic,
        title: r.title,
        criteriaTitles: r.criteria.map((c) => c.title),
      }));
    },
  };
}
