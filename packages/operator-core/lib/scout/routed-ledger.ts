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

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { gatherCompletions } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  lensWeightRowsFromReport,
  samplingWeightsWithFloor,
  type LensOutcomeReport,
  type LensWeightOptions,
  type LensWeightRow,
  type RoutedIdeaProvenance,
  type RoutedRail,
  type ScoutOutcomeReaders,
} from './outcome-feedback';
import { CREATIVE_LENSES, type CreativeLens } from './types';

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
  human_grade: number | null;
  human_feedback: string | null;
  graded_by: string | null;
  graded_at: Date | string | null;
}

function epochMsToIso(v: string | number | null): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return new Date(Number.isFinite(n) ? n : 0).toISOString();
}

/** timestamptz → ISO (postgres-js hands back a Date; tolerate a string). */
function tsToIso(v: Date | string | null): string | undefined {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
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
       ${input.addressesPatternRefs ? JSON.stringify(input.addressesPatternRefs) : null}::text::jsonb,
       ${routedAt})
    ON CONFLICT (idea_id) DO UPDATE SET
      harness_slug = EXCLUDED.harness_slug,
      cycle_id = EXCLUDED.cycle_id,
      lens = EXCLUDED.lens,
      rail = EXCLUDED.rail,
      routed_ref = EXCLUDED.routed_ref,
      title = EXCLUDED.title,
      addresses_pattern_refs = EXCLUDED.addresses_pattern_refs,
      routed_at = EXCLUDED.routed_at`;
  // Push the Learning tab's Scout view (learning.scout reads this ledger).
  // Fire-and-forget via a lazy import so the PG seam (+ its tests) never
  // statically depends on the SSE layer; a missing SSE bus is a no-op.
  void import('../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.scout'))
    .catch(() => {});
}

/** Input to {@link gradeRoutedIdea} — one grader's verdict on a routed idea (C-2). */
export interface GradeRoutedIdeaInput {
  /** The routed idea's id (the ledger PK). */
  ideaId: string;
  /** 1–5 integer (D-001); B-04's weight math derives winCredit = (grade − 1) / 4 (C-5). */
  grade: number;
  /**
   * Free-text critique — the ideator-priming channel's payload (C-4), not used
   * by the weight math. Omitting it on a regrade CLEARS the stored feedback:
   * the row always reflects the latest grade call in full.
   */
  feedback?: string;
  /**
   * Grader attribution (D-004). The tool layer (C-3) DERIVES this from the
   * caller role — it is never caller-supplied input.
   */
  gradedBy: 'owner' | 'Queen';
}

/** Result of {@link gradeRoutedIdea}. */
export interface GradeRoutedIdeaResult {
  applied: boolean;
  reason?: 'owner-grade-sovereign' | 'not-found';
}

/**
 * Record a grader's verdict on one routed idea (scout-idea-grading C-2): an
 * idempotent UPDATE of the four grade columns on the ledger row. Regrading is
 * allowed, with ONE precedence rule (D-004), enforced here rather than in any
 * prompt: the owner overwrites anything; the Queen never overwrites an owner
 * grade — that write is a no-op returning `{ applied: false, reason:
 * 'owner-grade-sovereign' }`.
 *
 * Keyed on the PK alone, NOT workspace-narrowed: like {@link readScoutPlanRefs},
 * the in-process tool dispatch path runs under the 'default' ALS workspace while
 * the ledger rows carry the active one (EI-346) — a workspace clause here would
 * silently no-op every grade from the tool surface. Admin client by design.
 */
export async function gradeRoutedIdea(input: GradeRoutedIdeaInput): Promise<GradeRoutedIdeaResult> {
  if (!Number.isInteger(input.grade) || input.grade < 1 || input.grade > 5) {
    throw new Error(`gradeRoutedIdea: grade must be an integer 1–5, got ${String(input.grade)}`);
  }
  const { sql } = getOrgPg();
  // D-004 in one statement. `graded_by IS DISTINCT FROM 'owner'` (not `<>`) so
  // ungraded rows (NULL graded_by) pass the guard for both graders.
  const updated = await sql<{ idea_id: string }[]>`
    UPDATE harness_shared.scout_routed_ideas
       SET human_grade = ${input.grade},
           human_feedback = ${input.feedback ?? null},
           graded_by = ${input.gradedBy},
           graded_at = now()
     WHERE idea_id = ${input.ideaId}
       AND (${input.gradedBy} = 'owner' OR graded_by IS DISTINCT FROM 'owner')
     RETURNING idea_id`;
  if (updated.length === 0) {
    const exists = await sql<{ idea_id: string }[]>`
      SELECT idea_id FROM harness_shared.scout_routed_ideas WHERE idea_id = ${input.ideaId}`;
    return exists.length === 0
      ? { applied: false, reason: 'not-found' }
      : { applied: false, reason: 'owner-grade-sovereign' };
  }
  // Push the Learning tab's Scout view — same lazy fire-and-forget seam as
  // recordRoutedIdea (a missing SSE bus is a no-op). Applied writes only.
  void import('../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.scout'))
    .catch(() => {});
  return { applied: true };
}

/**
 * The plan refs Scout has routed ("plan:<slug>"), across ALL workspaces — the
 * provenance lookup behind the plans:list `origin: 'scout'` flag. Deliberately
 * NOT workspace-narrowed: plan slugs are globally-unique dated identifiers and
 * the consuming list is already harness-scoped, while in-process tool dispatch
 * (read-dispatch's synthesized superuser ctx) runs under the 'default' ALS
 * workspace even though the ledger rows carry the active one — a workspace
 * clause here silently empties the join (live miss, 2026-06-11).
 */
export async function readScoutPlanRefs(): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ routed_ref: string }[]>`
    SELECT DISTINCT routed_ref FROM harness_shared.scout_routed_ideas WHERE rail = 'plan'`;
  return new Set(rows.map((r) => r.routed_ref));
}

/** Read routed-idea provenance for (workspace[, harness][, cycle]), newest-first. */
export async function readRoutedIdeas(opts: ScoutLedgerOpts = {}): Promise<RoutedIdeaProvenance[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limit ?? 2000;
  const rows = await sql<LedgerRow[]>`
    SELECT idea_id, lens, cycle_id, rail, routed_ref, title, addresses_pattern_refs, routed_at,
           human_grade, human_feedback, graded_by, graded_at
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${ws}
       ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}
       ${opts.cycleId ? sql`AND cycle_id = ${opts.cycleId}` : sql``}
     ORDER BY routed_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => {
    // C-1 → C-1b: the grade fields are optional on the provenance — absent =
    // ungraded. graded_by is gated to the seam's vocabulary ('owner' | 'Queen',
    // the only values gradeRoutedIdea writes); an unknown attribution drops the
    // field but keeps the grade.
    const gradedAt = r.graded_at ? tsToIso(r.graded_at) : undefined;
    return {
      ideaId: r.idea_id,
      lens: r.lens as CreativeLens,
      rail: r.rail as RoutedRail,
      routedRef: r.routed_ref,
      ...(r.cycle_id ? { cycleId: r.cycle_id } : {}),
      ...(r.title ? { title: r.title } : {}),
      routedAt: epochMsToIso(r.routed_at),
      ...(r.human_grade != null ? { humanGrade: Number(r.human_grade) } : {}),
      ...(r.human_feedback ? { humanFeedback: r.human_feedback } : {}),
      ...(r.graded_by === 'owner' || r.graded_by === 'Queen' ? { gradedBy: r.graded_by } : {}),
      ...(gradedAt ? { gradedAt } : {}),
    };
  });
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
 * Upsert the persisted per-lens meta-learning weights (P-033 —
 * `harness_shared.scout_lens_weights`, migration 208), one row per
 * (workspace, lens), in a single batched INSERT … ON CONFLICT. Called by
 * {@link refreshScoutOutcomes} after the ledger read path classifies outcomes;
 * the ideator lens-selection path reads it back via {@link getScoutLensWeights}.
 */
export async function upsertScoutLensWeights(
  rows: readonly LensWeightRow[],
  opts: { workspaceId?: string } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  // JS-array params don't serialize under the getOrgPg postgres-js client
  // (bytes.js "Received an instance of Array" — same class as the sql.json
  // jsonb quirk). Ship one JSON text param and explode it server-side.
  // wins/decided are FRACTIONAL under grade credit (C-5) but the columns are
  // int (migration 208), and jsonb_to_recordset's int cast ERRORS on "0.5"
  // rather than rounding — one mid-scale grade would kill the whole (best-
  // effort, warn-and-continue) upsert and strand the weights stale. Round
  // here; `weight` is computed pre-rounding, so only the analytics blur.
  const payload = JSON.stringify(
    rows.map((r) => ({
      lens: r.lens as string,
      wins: Math.round(r.wins),
      decided: Math.round(r.decided),
      weight: r.weight,
    })),
  );
  await sql`
    INSERT INTO harness_shared.scout_lens_weights (workspace_id, lens, wins, decided, weight, updated_at)
    SELECT ${ws}, x.lens, x.wins, x.decided, x.weight, now()
      FROM jsonb_to_recordset(${payload}::text::jsonb)
           AS x(lens text, wins int, decided int, weight numeric)
    ON CONFLICT (workspace_id, lens) DO UPDATE SET
      wins = EXCLUDED.wins,
      decided = EXCLUDED.decided,
      weight = EXCLUDED.weight,
      updated_at = EXCLUDED.updated_at`;
}

/**
 * Read the persisted per-lens weights for a workspace. Lenses with no row are
 * simply absent (the sampling floor in {@link samplingWeightsWithFloor} keeps
 * them alive); unknown lens ids in the table are ignored.
 *
 * Accepts an injected `sql` so workspace-routed readers (the learning.scout
 * snapshot, C-1c) can reuse the lens filtering without the admin client; when
 * omitted, the admin client is used as before.
 */
export async function readScoutLensWeights(
  opts: { workspaceId?: string; sql?: Sql } = {},
): Promise<Partial<Record<CreativeLens, number>>> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ lens: string; weight: string | number }[]>`
    SELECT lens, weight
      FROM harness_shared.scout_lens_weights
     WHERE workspace_id = ${ws}`;
  const out: Partial<Record<CreativeLens, number>> = {};
  for (const r of rows) {
    const w = typeof r.weight === 'number' ? r.weight : Number(r.weight);
    if ((CREATIVE_LENSES as readonly string[]).includes(r.lens) && Number.isFinite(w)) {
      out[r.lens as CreativeLens] = w;
    }
  }
  return out;
}

/**
 * The D-009 feedback hand-off for P-004: read the PERSISTED per-lens weights
 * (`scout_lens_weights`, written by {@link refreshScoutOutcomes} after each
 * cycle's outcome classification) and return them in the shape `runIdeators`
 * consumes (`lensWeights` + `extraIdeatorBudget`), so the next cycle's ideator
 * fan-out favours the lenses that have been winning. The weights go through
 * {@link samplingWeightsWithFloor}: every lens keeps ≥ {@link SAMPLING_FLOOR_FRACTION}
 * of its uniform share (no lens is ever zeroed), and an empty/unavailable table
 * degrades to uniform — safe before any idea has panned out, and a PG hiccup
 * never kills a Scout cycle.
 */
export async function getScoutLensWeights(
  opts: ScoutLedgerOpts & { floorFraction?: number; extraIdeatorBudget?: number } = {},
): Promise<{ lensWeights: Record<CreativeLens, number>; extraIdeatorBudget: number }> {
  let persisted: Partial<Record<CreativeLens, number>> = {};
  try {
    persisted = await readScoutLensWeights(opts.workspaceId ? { workspaceId: opts.workspaceId } : {});
  } catch (err) {
    // Best-effort read: fall through with no persisted signal → uniform weights.
    // eslint-disable-next-line no-console
    console.warn(
      '[scout/routed-ledger] readScoutLensWeights failed — falling back to uniform:',
      err instanceof Error ? err.message : err,
    );
  }
  return {
    lensWeights: samplingWeightsWithFloor(
      persisted,
      opts.floorFraction != null ? { floorFraction: opts.floorFraction } : {},
    ),
    extraIdeatorBudget: opts.extraIdeatorBudget ?? CREATIVE_LENSES.length,
  };
}

/**
 * Compute outcomes AND persist the per-idea outcome cache (won/lost/pending) back
 * to the ledger in one batched UPDATE, returning the report. The cache makes the
 * Queen's "which lenses win" report a cheap read; the Change-Feed join remains the
 * source of truth (this just memoizes the last derivation).
 *
 * P-033: this is also where the lens meta-learning loop closes — the per-lens
 * weights derived here are upserted into `scout_lens_weights` (best-effort) so
 * the next cycle's ideator fan-out ({@link getScoutLensWeights}) reads them back.
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

  // P-033: persist the per-lens weights the ideators read back next cycle.
  // Best-effort — a weight-upsert failure must not fail the outcome refresh.
  try {
    await upsertScoutLensWeights(lensWeightRowsFromReport(report), { workspaceId: ws });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[scout/routed-ledger] lens-weight upsert failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }

  return { ...report, generatedAt: new Date().toISOString() };
}
