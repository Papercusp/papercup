/**
 * WI-6554700010018098 — the admission fail-open runner's dedup RE-SCREEN.
 *
 * File-time duplicate detection runs on the create hot path under tight per-leg budgets
 * (fulltext-lexical-dupe-guard.ts: 1500 ms; semantic-dupe-guard.ts: embedder + vector
 * query). When a leg misses its budget or errors, the row is still filed — silent intake,
 * silent-intake-central-resolution-2026-09-01#D-001 — with `payload.dedupCoverage.degraded
 * = true`, meaning "could not check", not "checked clean".
 *
 * work-queue-exclusion-alarm-duplicates-2026-10-16 P-002 rightly kept such rows OUT of the
 * fail-open backstop: an unscreened row must not become scheduler work on a liveness timer.
 * But it left them waiting on the model promoter ALONE, and the promoter adjudicates ~7
 * rows per 30-minute tick with candidate rows ordered first. Measured 2026-10-20 ~13:30Z in
 * papercusp-workspace: 197 pending rows were degraded with NO candidates — waiting on a
 * review queue that was never going to reach them — and every new create whose lexical leg
 * timed out joined them. A one-time leg failure was converting into a permanent hold.
 *
 * The fix keeps P-002's invariant (nothing unscreened is admitted) and removes the dead
 * end: off the hot path, the fail-open runner RE-RUNS the screen for its over-age degraded
 * rows. Each row gets one of three outcomes:
 *   - clean (every required leg answered, no twin): `dedupCoverage` is rewritten as complete,
 *     so the same fail-open run admits the row as `unreviewed` exactly like any clean row;
 *   - candidates: they are stamped as `payload.dedupCandidates`, so the row becomes ordinary
 *     promoter review work, ordered first by readPendingBatch;
 *   - still degraded: the attempt is recorded, and the row waits out a cooldown so a
 *     persistently failing leg rotates through the backlog instead of pinning the batch.
 *
 * The RECENT-window lexical leg contributes candidates but never degrades a re-screen. At
 * create time it covers the embed-backfill gap for twins filed minutes earlier. By re-screen
 * time (the row is older than two promoter ticks), those older twins are embedded and
 * full-text indexed. The only rows in today's recent window are NEWER than this one, and
 * each of those runs its own create-time screen against this row. Letting that window's
 * completeness degrade the verdict would park rows for a reason unrelated to their own
 * duplicate status.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { DedupCandidateMethod, DedupCandidateStamp } from './agent-tools/work_items/dedup-candidates-stamp';
import { findFulltextLexicalDupes } from './agent-tools/work_items/fulltext-lexical-dupe-guard';
import { findRecentLexicalDupes } from './agent-tools/work_items/recent-lexical-dupe-guard';
import { findSemanticDupes, type DupeGuardDiagnostic, type SemanticDupeCandidate } from './agent-tools/work_items/semantic-dupe-guard';
import type { OrgSql } from './work-items';
import { mapWithConcurrency } from './gym/concurrency';
import { failOpenExclusionSql, type AdmissionFailOpenExclusion } from './work-items-admission';

/** Ceiling on the rows one fail-open run READS for re-screening; deliberately not the
 *  throttle. The wall budget below is the binding limit (WI-6554700010018182). */
export const DEFAULT_DEDUP_RESCREEN_BATCH_SIZE = 200;
/** Screens in flight at once inside the wall budget (WI-6554700010018182). Serial, the
 *  45s budget re-screened 16-48 rows per 30-minute run depending on load (~1-2s a screen),
 *  so a degraded backlog drained over hours. Measured live 2026-10-20 with 3 in flight:
 *  0.43 and 0.88 resolved rows per screen-second vs a serial median of 0.52, and the queue
 *  emptied inside the budget from the second run on. It does NOT scale linearly: wall time
 *  per screen rose with overlap, so the screens share a bottleneck (PG + embedder). Each
 *  leg also has its own resolve-null budget (lexical 1.5s, semantic 2.5s), so overlap that
 *  slows a leg turns it 'unavailable' and the row retries after the cooldown. Kept small. */
export const DEFAULT_DEDUP_RESCREEN_CONCURRENCY = 3;
/** Wall budget for the whole re-screen pass, so the must-never-starve admit step that
 *  follows is never delayed by a slow embedder or a loaded database. */
export const DEFAULT_DEDUP_RESCREEN_WALL_BUDGET_MS = 45_000;
/**
 * EI-28804090332254161 — consecutive leg-down screens that trip the per-pass breaker.
 *
 * The degraded backstop (ADMISSION_DEGRADED_RESCREEN_ATTEMPTS) counts attempts, and before
 * this breaker an attempt existed only once a real screen had run. A screen whose legs are
 * down is the SLOWEST kind: it waits out every leg's resolve-null budget. So the attempt
 * counter advanced at screen throughput, which collapses exactly when the backstop is needed.
 * Measured 2026-11-14 in papercusp-workspace: both legs answered `unavailable` on roughly
 * 85% of creates from >= 03:00Z. Every pass from 19:22Z to 22:52Z spent ~43s of its 45s budget
 * on 24-42 screens, and every one came back degraded. That is ~65 attempts/h against ~50 new
 * degraded rows/h needing 3 attempts each, so 505 rows sat pending with no bound and a row's
 * attempt 2 never came.
 *
 * Once this many screens IN A ROW come back degraded (or the screen threw), the pass has
 * measured that the legs are down. The rest of the selected batch is stamped with a
 * `screened:false` attempt that carries those row ids as evidence, without screening. The
 * row's coverage legs are left as last measured; nothing is fabricated per row. Attempts then
 * accrue at the cooldown rate, so the designed '>= ~2h of retries' bound holds during an
 * outage. A clean or candidate-bearing screen resets the run. The breaker never carries across
 * passes: every pass opens with real screens, so a recovered leg is noticed on the next tick.
 */
export const DEFAULT_DEDUP_RESCREEN_LEG_DOWN_THRESHOLD = 6;
export const DEDUP_RESCREEN_ACTOR = 'admission-fail-open:dedup-rescreen';

export interface DedupRescreenRow {
  id: string;
  harness: string;
  title: string;
  summary: string | null;
}

export interface DedupRescreenVerdict {
  /** `null` = the leg did not answer (disabled, timed out, errored). */
  lexical: 'ok' | 'unavailable';
  semantic: 'ok' | 'unavailable';
  /** Self-excluded, de-duplicated, strongest method first. */
  candidates: DedupCandidateStamp[];
  diagnostics?: Partial<Record<'lexical' | 'semantic' | 'screen', DupeGuardDiagnostic>>;
}

export type DedupRescreenScreen = (row: DedupRescreenRow) => Promise<DedupRescreenVerdict>;

/** The measurement that tripped a pass's leg-down breaker (EI-28804090332254161). */
export interface DedupRescreenLegDownTrip {
  /** Consecutive degraded/errored screens that tripped it. */
  afterConsecutive: number;
  /** Exactly those screened rows' ids, in completion order: the evidence the legs were down. */
  evidence: string[];
}

export interface DedupRescreenSummary {
  /** Rows actually SCREENED this pass (leg-down stamps are counted in `legDownSkipped`). */
  attempted: number;
  /** Coverage restored and no twin found: admitted by the same fail-open run. */
  clean: string[];
  /** Twins found and stamped: promoter-owned review work now. */
  candidatesFound: string[];
  /** A required leg still did not answer; retried after the cooldown. */
  stillDegraded: string[];
  /** The row changed under the re-screen (admitted, merged, stamped); write skipped. */
  raceSkipped: string[];
  /** The screen itself threw for these rows; they are retried after the cooldown. */
  errored: string[];
  /** True when the wall budget stopped the pass before the batch was exhausted. */
  budgetExhausted: boolean;
  /** Set when this pass measured the legs down; `null` when every screen ran. */
  legDownTrip: DedupRescreenLegDownTrip | null;
  /** Rows stamped with a `screened:false` attempt after the breaker tripped. */
  legDownSkipped: string[];
  /** Every measured unavailable screen, retained on the run after row coverage changes. */
  screenFailures?: Array<{ itemId: string; diagnostics: NonNullable<DedupRescreenVerdict['diagnostics']> }>;
}

interface PriorCoverage {
  lexical?: unknown;
  semantic?: unknown;
  degraded?: unknown;
  rescreen?: { attempts?: unknown; legDownAttempts?: unknown; prior?: unknown } | null;
}

/** Method for a semantic-guard candidate, mirroring the create path's stamp mapping in
 *  _create-core.ts (dedupCandidateStamps). */
function methodFor(candidate: SemanticDupeCandidate, hardIds: ReadonlySet<string>): DedupCandidateMethod {
  if (hardIds.has(candidate.id)) return 'semantic-hard';
  if (candidate.source === 'lexical-recent') return 'lexical-recent';
  if (candidate.source === 'lexical-fulltext') return 'lexical-fulltext';
  if (candidate.source === 'measurement-overlap') return 'measurement-overlap';
  return 'semantic-soft';
}

/**
 * The production screen: the same three guards the create path runs, in parallel, with the
 * row itself excluded. The semantic guard has no exclude seam, and the row is embedded by
 * now, so it would otherwise report itself as a perfect twin; it is filtered here.
 */
export async function screenWorkItemForDuplicates(row: DedupRescreenRow): Promise<DedupRescreenVerdict> {
  const input = { title: row.title, summary: row.summary ?? undefined };
  const diagnostics: NonNullable<DedupRescreenVerdict['diagnostics']> = {};
  const [semantic, recent, fulltext] = await Promise.all([
    findSemanticDupes({ ...input, harness: row.harness }, undefined, diagnostic => { diagnostics.semantic = diagnostic; }).catch(() => null),
    findRecentLexicalDupes({ ...input, harness: row.harness, excludeId: row.id }).catch(() => null),
    findFulltextLexicalDupes({ ...input, excludeId: row.id }, undefined, diagnostic => { diagnostics.lexical = diagnostic; }).catch(() => null),
  ]);
  const hardIds = new Set((semantic?.hard ?? []).map((c) => c.id));
  const ordered: SemanticDupeCandidate[] = [
    ...(semantic?.hard ?? []),
    ...(semantic?.soft ?? []),
    ...(recent?.candidates ?? []),
    ...(fulltext ?? []),
  ];
  const seen = new Set<string>([row.id]);
  const candidates: DedupCandidateStamp[] = [];
  for (const c of ordered) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    candidates.push({ id: c.id, similarity: c.similarity, method: methodFor(c, hardIds) });
  }
  return {
    lexical: fulltext === null ? 'unavailable' : 'ok',
    semantic: semantic === null ? 'unavailable' : 'ok',
    candidates,
    diagnostics,
  };
}

function priorAttempts(prior: PriorCoverage | null): number {
  return nonNegativeInt(prior?.rescreen?.attempts);
}

/** How many of the row's recorded attempts were leg-down stamps, not real screens. */
function priorLegDownAttempts(prior: PriorCoverage | null): number {
  return nonNegativeInt(prior?.rescreen?.legDownAttempts);
}

function nonNegativeInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The FIRST coverage verdict this row was filed with, kept across re-screens for audit. */
function originalCoverage(prior: PriorCoverage | null): unknown {
  if (prior?.rescreen?.prior !== undefined) return prior.rescreen.prior;
  if (!prior) return null;
  const { rescreen: _rescreen, ...rest } = prior;
  return rest;
}

/**
 * Re-screen up to `batchSize` over-age, candidate-free, degraded pending rows and write the
 * outcome back onto each row. Never throws for a single row: per-row failures are counted and
 * the row is retried after the cooldown. Throws only if the candidate read itself fails; the
 * caller isolates that so admission is never blocked by the re-screen.
 */
export async function rescreenDegradedPendingRows(opts: {
  workspaceId: string;
  /** `null` = workspace-wide (the production fail-open scope). */
  harnessSlug: string | null;
  /** Rows created before this epoch-ms are over-age (the fail-open cutoff). */
  cutoffMs: number;
  /** Rows re-screened at or after this epoch-ms are skipped this run. */
  cooldownCutoffMs: number;
  nowMs: number;
  runId: string;
  screen: DedupRescreenScreen;
  sql?: OrgSql;
  /** Extra row predicate (the workspace work-scope policy), built as `sql\`AND …\``. */
  scopePredicate?: postgres.Fragment;
  batchSize?: number;
  wallBudgetMs?: number;
  /** Screens in flight at once (default DEFAULT_DEDUP_RESCREEN_CONCURRENCY). */
  concurrency?: number;
  /** Consecutive degraded/errored screens that trip the per-pass leg-down breaker
   *  (default DEFAULT_DEDUP_RESCREEN_LEG_DOWN_THRESHOLD). */
  legDownThreshold?: number;
  now?: () => number;
}): Promise<DedupRescreenSummary> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const batchSize = opts.batchSize ?? DEFAULT_DEDUP_RESCREEN_BATCH_SIZE;
  const deadline = now() + (opts.wallBudgetMs ?? DEFAULT_DEDUP_RESCREEN_WALL_BUDGET_MS);
  const lastRescreenMs = sql`(CASE WHEN payload #>> '{dedupCoverage,rescreen,atMs}' ~ '^[0-9]+$'
      THEN (payload #>> '{dedupCoverage,rescreen,atMs}')::bigint ELSE 0 END)`;
  const rows = await sql<
    Array<{ feature_id: string; harness_slug: string; title: string | null; summary: string | null; coverage: PriorCoverage | null }>
  >`
    SELECT feature_id, harness_slug, title, summary, payload -> 'dedupCoverage' AS coverage
      FROM harness_shared.work_items
     WHERE workspace_id = ${opts.workspaceId}
       ${opts.harnessSlug === null ? sql`` : sql`AND harness_slug = ${opts.harnessSlug}`}
       ${opts.scopePredicate ?? sql``}
       AND admission = 'pending'
       AND (status IS NULL OR NOT harness_shared.work_item_status_is_terminal(status))
       AND created_ts < ${opts.cutoffMs}
       -- EI-25209690807142935: the shared exclusion record, first match wins — so this is
       -- exactly "no duplicate verdict, no candidates, coverage degraded".
       AND ${failOpenExclusionSql(sql)} = ${'degraded-dedup-coverage' satisfies AdmissionFailOpenExclusion}
       AND ${lastRescreenMs} < ${opts.cooldownCutoffMs}
     ORDER BY ${lastRescreenMs} ASC, created_ts ASC, feature_id ASC
     LIMIT ${batchSize}`;

  const summary: DedupRescreenSummary = {
    attempted: 0,
    clean: [],
    candidatesFound: [],
    stillDegraded: [],
    raceSkipped: [],
    errored: [],
    budgetExhausted: false,
    legDownTrip: null,
    legDownSkipped: [],
    screenFailures: [],
  };
  const diagnosticsById = new Map<string, NonNullable<DedupRescreenVerdict['diagnostics']>>();
  type RowOutcome = 'clean' | 'candidates' | 'degraded' | 'error' | 'write-error' | 'race' | 'leg-down';
  const rescreenOne = async (row: (typeof rows)[number], legDown: DedupRescreenLegDownTrip | null): Promise<RowOutcome> => {
    const prior = row.coverage && typeof row.coverage === 'object' ? row.coverage : null;
    const attempts = priorAttempts(prior) + 1;
    const legDownAttempts = priorLegDownAttempts(prior) + (legDown ? 1 : 0);
    let verdict: DedupRescreenVerdict | null = null;
    let diagnostics: DedupRescreenVerdict['diagnostics'];
    if (!legDown) {
      const screenStartedAt = now();
      try {
        verdict = await opts.screen({ id: row.feature_id, harness: row.harness_slug, title: row.title ?? '', summary: row.summary });
        diagnostics = verdict.diagnostics;
      } catch (error) {
        verdict = null;
        diagnostics = { screen: {
          outcome: 'unavailable', reason: 'error', phase: 'screen', elapsedMs: Math.max(0, now() - screenStartedAt),
          error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
        } };
      }
    }
    if (diagnostics) diagnosticsById.set(row.feature_id, diagnostics);
    // A feature-family row filed under the goal gate legitimately skipped the lexical leg
    // (_create-core.ts P-004); keep that leg out of its verdict rather than newly requiring it.
    const lexicalRequired = prior?.lexical !== 'skipped';
    // Not screened (leg-down stamp): the legs stay as last MEASURED on this row, never invented.
    const lastMeasured = (leg: unknown) => (typeof leg === 'string' ? leg : 'unavailable');
    const lexical = legDown
      ? lastMeasured(prior?.lexical)
      : verdict ? (lexicalRequired ? verdict.lexical : 'skipped') : 'unavailable';
    const semantic = legDown ? lastMeasured(prior?.semantic) : verdict ? verdict.semantic : 'unavailable';
    // A leg-down row was selected as degraded and was not re-measured, so it stays degraded.
    const degraded = legDown ? true : (lexicalRequired && lexical !== 'ok') || semantic !== 'ok';
    const candidates = verdict?.candidates ?? [];
    const outcome: 'clean' | 'candidates' | 'degraded' | 'error' = legDown
      ? 'degraded'
      : !verdict
        ? 'error'
        : candidates.length > 0
          ? 'candidates'
          : degraded
            ? 'degraded'
            : 'clean';
    const atMs = now();
    const patch: Record<string, unknown> = {
      dedupCoverage: {
        lexical,
        semantic,
        degraded,
        rescreen: {
          atMs,
          at: new Date(atMs).toISOString(),
          by: DEDUP_RESCREEN_ACTOR,
          runId: opts.runId,
          attempts,
          outcome,
          // EI-28804090332254161: whether THIS attempt ran a screen, and how many of the row's
          // attempts were leg-down stamps, so an audit can tell measured retries from waits.
          screened: !legDown,
          legDownAttempts,
          ...(legDown ? { legDown } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          prior: originalCoverage(prior),
        },
      },
    };
    if (candidates.length > 0) patch.dedupCandidates = candidates;
    let written: Array<{ feature_id: string }>;
    try {
      written = await sql<Array<{ feature_id: string }>>`
        UPDATE harness_shared.work_items
           SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb,
               updated_ts = ${atMs}
         WHERE workspace_id = ${opts.workspaceId}
           AND harness_slug = ${row.harness_slug}
           AND feature_id = ${row.feature_id}
           AND admission = 'pending'
           -- Race guard: still exactly the row the selector picked (same shared record).
           AND ${failOpenExclusionSql(sql)} = ${'degraded-dedup-coverage' satisfies AdmissionFailOpenExclusion}
         RETURNING feature_id`;
    } catch {
      // Unstamped, so the next run picks the row up again. Throwing here would reject the
      // pool while sibling screens kept writing after this function had returned. A write
      // failure says nothing about the legs, so it never feeds the leg-down breaker.
      return 'write-error';
    }
    if (written.length === 0) return 'race';
    return legDown ? 'leg-down' : outcome;
  };

  // EI-28804090332254161: the per-pass leg-down breaker (DEFAULT_DEDUP_RESCREEN_LEG_DOWN_THRESHOLD).
  const legDownThreshold = Math.max(1, Math.floor(opts.legDownThreshold ?? DEFAULT_DEDUP_RESCREEN_LEG_DOWN_THRESHOLD));
  const consecutiveLegDown: string[] = [];

  // WI-6554700010018182: overlap screens; the deadline is checked before each one STARTS,
  // so the wall budget still bounds the pass. Outcomes come back in selection order.
  const outcomes = await mapWithConcurrency(
    rows,
    opts.concurrency ?? DEFAULT_DEDUP_RESCREEN_CONCURRENCY,
    async (row): Promise<RowOutcome | null> => {
      if (now() >= deadline) return null;
      if (summary.legDownTrip) return rescreenOne(row, summary.legDownTrip);
      summary.attempted += 1;
      const outcome = await rescreenOne(row, null);
      if (outcome === 'degraded' || outcome === 'error') {
        consecutiveLegDown.push(row.feature_id);
        if (!summary.legDownTrip && consecutiveLegDown.length >= legDownThreshold) {
          summary.legDownTrip = { afterConsecutive: consecutiveLegDown.length, evidence: [...consecutiveLegDown] };
        }
      } else if (outcome === 'clean' || outcome === 'candidates') {
        consecutiveLegDown.length = 0;
      }
      return outcome;
    },
  );
  for (const [i, outcome] of outcomes.entries()) {
    const id = rows[i]!.feature_id;
    const diagnostics = diagnosticsById.get(id);
    if (diagnostics && Object.values(diagnostics).some(diagnostic => diagnostic.outcome === 'unavailable')) {
      summary.screenFailures!.push({ itemId: id, diagnostics });
    }
    if (outcome === null) summary.budgetExhausted = true;
    else if (outcome === 'leg-down') summary.legDownSkipped.push(id);
    else if (outcome === 'race') summary.raceSkipped.push(id);
    else if (outcome === 'clean') summary.clean.push(id);
    else if (outcome === 'candidates') summary.candidatesFound.push(id);
    else if (outcome === 'degraded') summary.stillDegraded.push(id);
    else summary.errored.push(id);
  }
  return summary;
}
