/**
 * Hyperbee → PG projection for PER-PART plan federation (plan-federation-regrain
 * 2026-06-13 P-006). Receives ONE part op → LWW-upserts harness_plan_parts → (only
 * when papercusp-plan-part-federation is ON) recomposes harness_plans.content from
 * the merged live parts. Because an op is scoped to one part key, concurrent edits
 * to DIFFERENT parts merge instead of clobbering (D-009 of shared-hive-hardening).
 *
 * DARK: registered always (additive) but inert until the flag flips — with it OFF
 * no peer captures part ops (capture is flag-gated too), and the harness_plans
 * recompose here is ALSO flag-gated, so an asymmetric-peer stray op only touches
 * the (dark) harness_plan_parts table and never the live harness_plans.content.
 *
 * tableTag 'plan-parts'. CDC-captured → skipOwnOps. Key = `<plan_slug>/<part_key>`
 * == the harness_plan_parts.part_fed_key generated column (mig 270).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { joinFederatedParts, hashPlanContent, type FederatedPart, type PlanPartKind } from '@papercusp/plan-parser';
import { FLAGS } from '@papercusp/flags';
import type { TableProjection, ProvenanceContext } from '../projection';
import { PgPlanPartsStore, type PlanPartsStore } from '../../../plan-parts/store';

/** The federated subset of a harness_plan_parts row (the wire shape). */
export interface PlanPartWireRow {
  harness_slug: string;
  plan_slug: string;
  part_key: string;
  kind: PlanPartKind;
  body: string;
  ordinal: number;
  tombstone: boolean;
}

export function isPlanPartWireRow(input: unknown): input is PlanPartWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' && r.harness_slug.length > 0 &&
    typeof r.plan_slug === 'string' && r.plan_slug.length > 0 &&
    typeof r.part_key === 'string' && r.part_key.length > 0 &&
    typeof r.kind === 'string' &&
    typeof r.body === 'string' &&
    typeof r.ordinal === 'number' &&
    typeof r.tombstone === 'boolean'
  );
}

export interface HarnessPlanPartsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** Test seam — the part store (default: PgPlanPartsStore over `sql`). */
  store?: PlanPartsStore;
  /** Test seam — the harness_plans recompose sink (default: the sql UPDATE below). */
  recomposeSink?: (planSlug: string, content: string, contentHash: string, provenance?: ProvenanceContext) => Promise<void>;
  /** Test seam — the local flag gate (default: getFlag(PLAN_PART_FEDERATION,'system')). */
  isFlagOn?: () => Promise<boolean>;
}

function composeKey(row: PlanPartWireRow): string {
  return `${row.plan_slug}/${row.part_key}`; // == harness_plan_parts.part_fed_key (mig 270)
}

function decodeValue(raw: unknown): PlanPartWireRow | null {
  return isPlanPartWireRow(raw) ? raw : null;
}

async function flagOn(opts: HarnessPlanPartsProjectionOpts): Promise<boolean> {
  if (opts.isFlagOn) return opts.isFlagOn();
  const { getFlag } = await import('@papercusp/flags/server');
  return getFlag(FLAGS.PLAN_PART_FEDERATION, 'system');
}

/** LWW-guarded UPDATE of harness_plans.content from the recomposed parts (only
 *  the federated DOCUMENT fields; version, op-state, and workspace stay as the
 *  whole-blob projection (projections/harness-plans.ts) manages them). */
function defaultRecomposeSink(opts: HarnessPlanPartsProjectionOpts) {
  return async (planSlug: string, content: string, contentHash: string, provenance?: ProvenanceContext): Promise<void> => {
    const sql = opts.sql ?? getOrgPg().sql;
    const fedTs = provenance?.ts ?? null;
    await sql`
      UPDATE harness_shared.harness_plans
         SET content = ${content}, content_hash = ${contentHash}, version = version + 1, fed_ts = ${fedTs}
       WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug} AND plan_slug = ${planSlug}
         AND (fed_ts IS NULL OR ${fedTs}::bigint IS NULL OR ${fedTs}::bigint >= fed_ts)
    `;
  };
}

async function recompose(opts: HarnessPlanPartsProjectionOpts, store: PlanPartsStore, planSlug: string, provenance?: ProvenanceContext): Promise<void> {
  if (!(await flagOn(opts))) return; // DARK / asymmetric-peer guard — never drive harness_plans when off
  const content = joinFederatedParts(await store.getParts(planSlug));
  const sink = opts.recomposeSink ?? defaultRecomposeSink(opts);
  await sink(planSlug, content, hashPlanContent(content), provenance);
}

function storeFor(opts: HarnessPlanPartsProjectionOpts): PlanPartsStore {
  return opts.store ?? new PgPlanPartsStore(opts.sql ?? getOrgPg().sql, opts.workspaceId, opts.harnessSlug);
}

async function applyPart(opts: HarnessPlanPartsProjectionOpts, row: PlanPartWireRow, provenance?: ProvenanceContext): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const store = storeFor(opts);
  const part: FederatedPart = {
    key: row.part_key,
    kind: row.kind,
    text: row.body,
    order: row.ordinal,
    fedTs: provenance?.ts ?? 0,
    ...(provenance?.authorPubkey ? { author: provenance.authorPubkey } : {}),
    ...(row.tombstone ? { tombstone: true as const } : {}),
  };
  await store.upsertPart(row.plan_slug, part); // always safe (dark table); LWW in the store
  await recompose(opts, store, row.plan_slug, provenance);
}

async function deletePart(opts: HarnessPlanPartsProjectionOpts, key: string, delTs?: number): Promise<void> {
  const slash = key.indexOf('/');
  if (slash < 0) return;
  const planSlug = key.slice(0, slash);
  const partKey = key.slice(slash + 1);
  const store = storeFor(opts);
  await store.upsertPart(planSlug, { key: partKey, kind: 'item', text: '', order: 0, fedTs: delTs ?? 0, tombstone: true });
  await recompose(opts, store, planSlug);
}

export function buildHarnessPlanPartsProjection(opts: HarnessPlanPartsProjectionOpts): TableProjection<PlanPartWireRow> {
  return {
    tableTag: 'plan-parts',
    // CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => applyPart(opts, row, provenance),
    deleteFromPg: (key, delTs) => deletePart(opts, key, delTs),
  };
}

export const _testing = { composeKey, decodeValue, isPlanPartWireRow };
