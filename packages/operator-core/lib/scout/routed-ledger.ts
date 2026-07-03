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
import { isWorkspaceCoordinationOn, workspaceBrainScopeKey, workspaceBrainReadKeys } from '../workspace-brain-scope';
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
  /**
   * The CreativeLens that produced the idea. For an `origin:'su-ideate'` row (P-005) there is
   * no Scout lens, so the sentinel `'su-ideate'` is accepted — it never reaches lens-weight
   * learning (those readers filter origin='scout'), so it cannot skew the diversity floor.
   */
  lens: CreativeLens | 'su-ideate';
  rail: RoutedRail;
  /** The Change Feed ref of the artifact created: "plan:<slug>" | "gym:<id>" | "wi:<id>". */
  routedRef: string;
  /** Which Hive this belongs to (scope). */
  harnessSlug: string;
  /**
   * The hive the idea came FROM (workspace-scoped-coordination D-003 source-hive
   * tag). AUTO-RESOLVED from harnessSlug (→ hive-home) when omitted — a harness is
   * a MEMBER of a hive, so the source hive is the harness's hive-home, not its
   * slug. An explicit cross-hive caller may set it. ALWAYS persisted non-null (the
   * "required" contract is enforced here on the write path, not a DB NOT NULL —
   * migration 333).
   */
  sourceHive?: string;
  /** Optional best-effort hint: the hive the idea is ABOUT (a cross-hive idea, D-003). */
  targetHive?: string;
  cycleId?: string;
  title?: string;
  addressesPatternRefs?: string[];
  /** Epoch ms; defaults to now. */
  routedAt?: number;
  /** Override the active workspace (tests). */
  workspaceId?: string;
  /**
   * The ORIGIN dimension (su-loop-capability-parity P-005 / D-009), ORTHOGONAL to `lens`:
   * 'scout' (default — a Scout-routed idea, counts toward per-lens weight learning) vs
   * 'su-ideate' (an SU session's IDEATE-pass origination — rides the ledger for
   * provenance/grading/priming but is EXCLUDED from lens-weight learning, so it never skews
   * the diversity floor). NOT a pseudo-lens.
   */
  origin?: 'scout' | 'su-ideate';
}

/** Read/scope options shared by the ledger read paths. */
export interface ScoutLedgerOpts {
  workspaceId?: string;
  harnessSlug?: string;
  /** The hive home slug — per-hive lens-weight scope (per-hive-learning-loops D-008). */
  hiveSlug?: string;
  cycleId?: string;
  limit?: number;
  /**
   * ORIGIN filter (su-loop-capability-parity P-005 / D-009). DEFAULT 'scout' — so every
   * existing lens-weight / outcome / cadence reader stays byte-identical (all pre-migration
   * rows are 'scout') AND automatically EXCLUDES 'su-ideate' rows from lens learning. The
   * SU-priming path passes 'su-ideate'; 'all' reads both (admin / cross-origin views).
   */
  origin?: 'scout' | 'su-ideate' | 'all';
}

/** The origin WHERE fragment for a ledger read (default 'scout' — D-009 lens-learning isolation). */
function originClause(sql: ReturnType<typeof getOrgPg>['sql'], origin: ScoutLedgerOpts['origin']) {
  const o = origin ?? 'scout';
  return o === 'all' ? sql`` : sql`AND origin = ${o}`;
}

interface LedgerRow {
  idea_id: string;
  lens: string;
  cycle_id: string | null;
  rail: string;
  routed_ref: string;
  source_hive: string | null;
  target_hive: string | null;
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
 * D-003 target-hive derivation (workspace-scoped-coordination P-002): a
 * rubric-rating digest pattern encodes the hive it measured as an `@<hive>`
 * suffix on its ref (corpus-digest.ts buildRubricRatings:
 * `rubric:<rubricRef>#<criterion>@<sourceHive>`). When the workspace-Scout routes
 * an idea derived from such a pattern, that hive is where the resulting work
 * belongs — the OPTIONAL target hint the workspace-Queen (P-003) confirms + places
 * on (D-003: "resolving the true target + routing is the workspace-brain's job").
 * Returns the hive of the first ref that carries one, or undefined (free-text /
 * non-rubric patterns carry no hive tag). Pure + ungated — it only enriches the
 * routed-idea provenance; the actual placement-to-hive is the Queen's.
 */
export function hiveFromPatternRefs(refs?: readonly string[]): string | undefined {
  if (!refs) return undefined;
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.startsWith('rubric:')) continue;
    const at = ref.lastIndexOf('@');
    if (at >= 0 && at < ref.length - 1) return ref.slice(at + 1);
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
  // D-003 source-hive tag — ALWAYS populated (the "required" contract lives on the
  // write path, not a DB NOT NULL; migration 333). Resolve the hive-home from the
  // harness when an explicit sourceHive isn't supplied (harness ≠ hive in a
  // multi-member hive); best-effort, falling back to harnessSlug (the standalone
  // hive-home proxy) so it is NEVER null. Mirrors getScoutLensWeights's resolution.
  let sourceHive = input.sourceHive;
  if (!sourceHive) {
    try {
      const { hiveHomeSlugForHarness } = await import('../hive-federation');
      sourceHive = (await hiveHomeSlugForHarness(ws, input.harnessSlug)) ?? input.harnessSlug;
    } catch {
      // best-effort — fall back to the harness slug as the hive-home proxy.
      sourceHive = input.harnessSlug;
    }
  }
  // D-003 optional target hive: an explicit hint wins; else derive it from the
  // addressed rubric pattern's `@<hive>` tag (the cross-hive routing signal the
  // workspace-Queen places on). Null when neither is present.
  const targetHive = input.targetHive ?? hiveFromPatternRefs(input.addressesPatternRefs) ?? null;
  // P-005 (D-009): the origin dimension. Default 'scout' so every existing caller (which
  // passes no origin) lands a Scout-origin row exactly as before.
  const origin = input.origin ?? 'scout';
  await sql`
    INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id, lens, rail,
       routed_ref, title, addresses_pattern_refs, routed_at, origin)
    VALUES
      (${input.ideaId}, ${ws}, ${input.harnessSlug}, ${sourceHive}, ${targetHive},
       ${input.cycleId ?? null}, ${input.lens},
       ${input.rail}, ${input.routedRef}, ${input.title ?? null},
       ${input.addressesPatternRefs ? JSON.stringify(input.addressesPatternRefs) : null}::text::jsonb,
       ${routedAt}, ${origin})
    ON CONFLICT (idea_id) DO UPDATE SET
      harness_slug = EXCLUDED.harness_slug,
      source_hive = EXCLUDED.source_hive,
      target_hive = EXCLUDED.target_hive,
      cycle_id = EXCLUDED.cycle_id,
      lens = EXCLUDED.lens,
      rail = EXCLUDED.rail,
      routed_ref = EXCLUDED.routed_ref,
      title = EXCLUDED.title,
      addresses_pattern_refs = EXCLUDED.addresses_pattern_refs,
      routed_at = EXCLUDED.routed_at,
      origin = EXCLUDED.origin`;
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
  // ungraded rows (NULL graded_by) pass the guard for both graders. The
  // self-join FROM reads the PRE-update grade in the same statement (FB-15:
  // 'regrade' detection for the owner-interaction capture below) — same
  // unnarrowed idea_id predicate as before, so apply semantics are unchanged.
  const updated = await sql<
    {
      idea_id: string;
      lens: string;
      rail: string;
      routed_ref: string;
      title: string | null;
      prev_grade: number | null;
      prev_graded_by: string | null;
    }[]
  >`
    UPDATE harness_shared.scout_routed_ideas t
       SET human_grade = ${input.grade},
           human_feedback = ${input.feedback ?? null},
           graded_by = ${input.gradedBy},
           graded_at = now()
      FROM (SELECT idea_id, human_grade AS prev_grade, graded_by AS prev_graded_by
              FROM harness_shared.scout_routed_ideas
             WHERE idea_id = ${input.ideaId}) prev
     WHERE t.idea_id = prev.idea_id
       AND (${input.gradedBy} = 'owner' OR t.graded_by IS DISTINCT FROM 'owner')
     RETURNING t.idea_id, t.lens, t.rail, t.routed_ref, t.title,
               prev.prev_grade, prev.prev_graded_by`;
  if (updated.length === 0) {
    const exists = await sql<{ idea_id: string }[]>`
      SELECT idea_id FROM harness_shared.scout_routed_ideas WHERE idea_id = ${input.ideaId}`;
    return exists.length === 0
      ? { applied: false, reason: 'not-found' }
      : { applied: false, reason: 'owner-grade-sovereign' };
  }
  // FB-15 (P-043): an applied OWNER grade is the cleanest implicit-attention
  // signal — append it to the owner_interactions stream (same lazy
  // fire-and-forget seam as the SSE push below; capture must never affect the
  // grade write). Queen grades are deliberately NOT captured: the preference
  // model learns the owner's attention, nobody else's.
  const row = updated[0];
  if (input.gradedBy === 'owner') {
    void import('../owner-preference/interactions')
      .then((m) =>
        m.recordOwnerInteraction({
          kind: row.prev_grade != null && row.prev_graded_by === 'owner' ? 'regrade' : 'grade',
          subjectKind: 'routed-idea',
          subjectId: row.idea_id,
          payload: {
            grade: input.grade,
            ...(row.prev_grade != null ? { prevGrade: Number(row.prev_grade) } : {}),
            lens: row.lens,
            rail: row.rail,
            routedRef: row.routed_ref,
            ...(row.title ? { title: row.title } : {}),
          },
        }),
      )
      .catch(() => {});
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

/**
 * Count routed ideas for a scope by resolution: `total` ever routed + how many are
 * still `pending` (the cached `outcome` column is NULL or 'pending'). Powers the
 * cadence `ideas-drained` trigger — `total > 0 && pending === 0` ⇒ the idea
 * pipeline has fully resolved, so Scout regenerates (owner-set 2026-06-18). Reads
 * the cached `outcome` (refreshed each cycle by {@link refreshScoutOutcomes}); a
 * slightly-stale count is fine — the hourly heartbeat is the backstop.
 */
export async function readIdeaQueueStatus(
  opts: ScoutLedgerOpts = {},
): Promise<{ total: number; pending: number }> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ total: string; pending: string }[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE outcome IS NULL OR outcome = 'pending') AS pending
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${ws}
       ${originClause(sql, opts.origin)}
       ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}`;
  const row = rows[0] ?? { total: '0', pending: '0' };
  return { total: Number(row.total), pending: Number(row.pending) };
}

/** Read routed-idea provenance for (workspace[, harness][, cycle]), newest-first. */
export async function readRoutedIdeas(opts: ScoutLedgerOpts = {}): Promise<RoutedIdeaProvenance[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limit ?? 2000;
  const rows = await sql<LedgerRow[]>`
    SELECT idea_id, lens, cycle_id, rail, routed_ref, source_hive, target_hive, title,
           addresses_pattern_refs, routed_at,
           human_grade, human_feedback, graded_by, graded_at
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${ws}
       ${originClause(sql, opts.origin)}
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
      ...(r.source_hive ? { sourceHive: r.source_hive } : {}),
      ...(r.target_hive ? { targetHive: r.target_hive } : {}),
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
  opts: { workspaceId?: string; hiveSlug?: string } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  // scout_lens_weights PK is (workspace_id, hive_slug, lens) — without a hive we
  // cannot persist. Best-effort contract (refreshScoutOutcomes wraps this in
  // try/catch): warn + skip rather than throw a NOT NULL violation.
  if (!opts.hiveSlug) {
    // eslint-disable-next-line no-console
    console.warn('[scout/routed-ledger] upsertScoutLensWeights: no hiveSlug — skipping lens-weight persist');
    return;
  }
  const hiveSlug = opts.hiveSlug;
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
    INSERT INTO harness_shared.scout_lens_weights (workspace_id, hive_slug, lens, wins, decided, weight, updated_at)
    SELECT ${ws}, ${hiveSlug}, x.lens, x.wins, x.decided, x.weight, now()
      FROM jsonb_to_recordset(${payload}::text::jsonb)
           AS x(lens text, wins int, decided int, weight numeric)
    ON CONFLICT (workspace_id, hive_slug, lens) DO UPDATE SET
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
  opts: { workspaceId?: string; sql?: Sql; hiveSlug?: string } = {},
): Promise<Partial<Record<CreativeLens, number>>> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ lens: string; weight: string | number }[]>`
    SELECT lens, weight
      FROM harness_shared.scout_lens_weights
     WHERE workspace_id = ${ws}
       ${opts.hiveSlug ? sql`AND hive_slug = ${opts.hiveSlug}` : sql``}`;
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
  // Resolve the hive home slug from harnessSlug (per-hive lens weights, D-008).
  // A standalone harness (not part of a shared Hive) scopes weights under its own slug.
  let hiveSlug = opts.hiveSlug ?? opts.harnessSlug;
  if (!opts.hiveSlug && opts.harnessSlug) {
    try {
      const { hiveHomeSlugForHarness } = await import('../hive-federation');
      hiveSlug = (await hiveHomeSlugForHarness(opts.workspaceId ?? activeWorkspaceId(), opts.harnessSlug)) ?? opts.harnessSlug;
    } catch {
      // best-effort: keep the harnessSlug fallback
    }
  }
  const ws = opts.workspaceId ?? activeWorkspaceId();
  // K1 workspace-brain scope (workspace-scoped-coordination D-006): when
  // WORKSPACE_COORDINATION is ON, the workspace-Scout reads its lens weights from
  // the workspace-sentinel row (hive_slug = workspaceId), falling back to the
  // legacy per-hive row until the sentinel is first written (zero regression).
  // OFF ⇒ the per-hive read, byte-identical to today.
  const on = await isWorkspaceCoordinationOn();
  let persisted: Partial<Record<CreativeLens, number>> = {};
  try {
    if (hiveSlug) {
      for (const key of workspaceBrainReadKeys(ws, hiveSlug, on)) {
        persisted = await readScoutLensWeights({ workspaceId: ws, hiveSlug: key });
        if (Object.keys(persisted).length > 0) break;
      }
    } else {
      // No hive context → the workspace-wide read (today's behavior).
      persisted = await readScoutLensWeights({ workspaceId: ws });
    }
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
  // Resolve the hive home slug for the per-hive PK (per-hive-learning-loops D-008).
  // A standalone harness (not part of a shared Hive) scopes weights under its own slug.
  let hiveSlug = opts.harnessSlug;
  if (opts.harnessSlug) {
    try {
      const { hiveHomeSlugForHarness } = await import('../hive-federation');
      hiveSlug = (await hiveHomeSlugForHarness(ws, opts.harnessSlug)) ?? opts.harnessSlug;
    } catch {
      // best-effort — keep the harnessSlug fallback
    }
  }
  // K1 workspace-brain scope (workspace-scoped-coordination D-006): when
  // WORKSPACE_COORDINATION is ON, the workspace-Scout persists ONE consolidated
  // lens-weight row per workspace under the sentinel (hive_slug = workspaceId);
  // OFF ⇒ the per-hive row, byte-identical to today.
  const scopeSlug = workspaceBrainScopeKey(ws, hiveSlug ?? '', await isWorkspaceCoordinationOn());
  try {
    await upsertScoutLensWeights(lensWeightRowsFromReport(report), {
      workspaceId: ws,
      ...(scopeSlug ? { hiveSlug: scopeSlug } : {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[scout/routed-ledger] lens-weight upsert failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }

  return { ...report, generatedAt: new Date().toISOString() };
}
