/**
 * routed-ledger.ts — Scout P-013 production wiring: the routed-idea provenance +
 * outcome ledger over `harness_shared.scout_routed_ideas` (migration 194).
 *
 * The seam between P-007 (routing, su-ce4bd) and P-013 (outcome feedback):
 *   - P-007 calls {@link recordRoutedIdea} when it dispatches an idea into a rail,
 *     persisting WHICH LENS produced WHICH artifact (the one fact the Change Feed
 *     cannot carry).
 *   - P-013 reads it back via {@link buildScoutOutcomeReaders} / {@link getScoutLensOutcomes},
 *     joining each `routedRef` to the Change Feed to derive per-lens outcomes
 *     (the pure core lives in ./outcome-feedback).
 *
 * The pure computation is fully unit-tested in outcome-feedback.test.ts; THIS
 * module is the thin PG layer (mirrors curation/change-feed-deps.ts), pinned by
 * routed-ledger.integration.test.ts against the real migrated schema.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { gatherCompletions } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  type LensOutcomeReport,
  type LensWeightOptions,
  type RoutedIdeaProvenance,
  type RoutedRail,
  type ScoutOutcomeReaders,
} from './outcome-feedback';
import type { CreativeLens } from './types';

/** Input to {@link recordRoutedIdea} — the provenance P-007 persists at routing time. */
export interface RecordRoutedIdeaInput {
  ideaId: string;
  lens: CreativeLens;
  rail: RoutedRail;
  /** The Change Feed ref of the artifact created: "plan:<slug>" | "gym:<id>" | "wi:<id>". */
  routedRef: string;
  /** Which Hive this belongs to (scope). */
  harnessSlug: string;
  cycleId?: string;
  title?: string;
  addressesPatternRefs?: string[];
  /** Epoch ms; defaults to now. */
  routedAt?: number;
  /** Override the active workspace (tests). */
  workspaceId?: string;
}

/** Read/scope options shared by the ledger read paths. */
export interface ScoutLedgerOpts {
  workspaceId?: string;
  harnessSlug?: string;
  cycleId?: string;
  limit?: number;
}

interface LedgerRow {
  idea_id: string;
  lens: string;
  cycle_id: string | null;
  rail: string;
  routed_ref: string;
  title: string | null;
  addresses_pattern_refs: string[] | null;
  routed_at: string;
}

function epochMsToIso(v: string | number | null): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return new Date(Number.isFinite(n) ? n : 0).toISOString();
}

/**
 * Persist (upsert by idea_id) one routed idea's provenance. Called by P-007 once
 * it knows the created artifact's change-feed ref. Idempotent — re-routing the
 * same idea overwrites its row.
 */
export async function recordRoutedIdea(input: RecordRoutedIdeaInput): Promise<void> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const routedAt = input.routedAt ?? Date.now();
  await sql`
    INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, cycle_id, lens, rail, routed_ref, title,
       addresses_pattern_refs, routed_at)
    VALUES
      (${input.ideaId}, ${ws}, ${input.harnessSlug}, ${input.cycleId ?? null}, ${input.lens},
       ${input.rail}, ${input.routedRef}, ${input.title ?? null},
       ${sql.json(input.addressesPatternRefs ?? null)}, ${routedAt})
    ON CONFLICT (idea_id) DO UPDATE SET
      harness_slug = EXCLUDED.harness_slug,
      cycle_id = EXCLUDED.cycle_id,
      lens = EXCLUDED.lens,
      rail = EXCLUDED.rail,
      routed_ref = EXCLUDED.routed_ref,
      title = EXCLUDED.title,
      addresses_pattern_refs = EXCLUDED.addresses_pattern_refs,
      routed_at = EXCLUDED.routed_at`;
}

/** Read routed-idea provenance for (workspace[, harness][, cycle]), newest-first. */
export async function readRoutedIdeas(opts: ScoutLedgerOpts = {}): Promise<RoutedIdeaProvenance[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limit ?? 2000;
  const rows = await sql<LedgerRow[]>`
    SELECT idea_id, lens, cycle_id, rail, routed_ref, title, addresses_pattern_refs, routed_at
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${ws}
       ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}
       ${opts.cycleId ? sql`AND cycle_id = ${opts.cycleId}` : sql``}
     ORDER BY routed_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    ideaId: r.idea_id,
    lens: r.lens as CreativeLens,
    rail: r.rail as RoutedRail,
    routedRef: r.routed_ref,
    ...(r.cycle_id ? { cycleId: r.cycle_id } : {}),
    ...(r.title ? { title: r.title } : {}),
    routedAt: epochMsToIso(r.routed_at),
  }));
}

/**
 * The production reader bag for the pure outcome core: routed-idea provenance
 * from the ledger + the Change Feed completions. (gatherCompletions wraps each
 * Change Feed reader defensively, so one bad source never empties the join.)
 */
export function buildScoutOutcomeReaders(opts: ScoutLedgerOpts = {}): ScoutOutcomeReaders {
  return {
    routedIdeas: () => readRoutedIdeas(opts),
    completions: () => gatherCompletions(buildChangeFeedReaders()),
  };
}

/**
 * Compute the per-lens outcome report from live data (read-only). The headline
 * P-013 surface: the lens weights the ideator (P-004) reads back to bias the next
 * cycle's generation (D-009), with the diversity floor preserving every lens.
 */
export async function getScoutLensOutcomes(
  opts: ScoutLedgerOpts & { weights?: LensWeightOptions } = {},
): Promise<LensOutcomeReport> {
  const [provenance, completions] = await Promise.all([
    readRoutedIdeas(opts),
    gatherCompletions(buildChangeFeedReaders()),
  ]);
  const report = computeLensOutcomes(provenance, completions, opts.weights);
  return { ...report, generatedAt: new Date().toISOString() };
}

/**
 * Compute outcomes AND persist the per-idea outcome cache (won/lost/pending) back
 * to the ledger in one batched UPDATE, returning the report. The cache makes the
 * Queen's "which lenses win" report a cheap read; the Change-Feed join remains the
 * source of truth (this just memoizes the last derivation).
 */
export async function refreshScoutOutcomes(
  opts: ScoutLedgerOpts & { weights?: LensWeightOptions } = {},
): Promise<LensOutcomeReport> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const [provenance, completions] = await Promise.all([
    readRoutedIdeas(opts),
    gatherCompletions(buildChangeFeedReaders()),
  ]);

  if (provenance.length > 0) {
    const byRef = new Map(completions.map((e) => [e.ref, e]));
    const ids = provenance.map((p) => p.ideaId);
    const outcomes = provenance.map((p) => classifyIdeaOutcome(p, byRef) as string);
    const now = Date.now();
    // One batched UPDATE … FROM unnest(…) — no per-row serial loop.
    await sql`
      UPDATE harness_shared.scout_routed_ideas AS t
         SET outcome = d.outcome, outcome_checked_at = ${now}
        FROM (
          SELECT * FROM unnest(${ids}::text[], ${outcomes}::text[]) AS u(idea_id, outcome)
        ) AS d
       WHERE t.idea_id = d.idea_id AND t.workspace_id = ${ws}`;
  }

  const report = computeLensOutcomes(provenance, completions, opts.weights);
  return { ...report, generatedAt: new Date().toISOString() };
}
