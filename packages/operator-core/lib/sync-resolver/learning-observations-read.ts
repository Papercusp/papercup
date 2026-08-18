/**
 * The compute behind the `learning.observations` sync resolver — extracted so the
 * PRECOMPUTED default variant (a `system:precompute-derived-reads` producer; see
 * derived-reads/producers.ts) and the resolver's live inline path for NON-default
 * variants (a state filter / custom limit) run the EXACT same code and can never
 * drift (whole-app-sync-payload-audit phase2 P-005).
 *
 * The Observations pane is a BROWSE feed of pre-idea sensor readings from the
 * turn-end reflection step (OBSERVATION_TOPIC lane) — no ranking/triage. The
 * measured 0.22s / 152KB read was listIssues + countIssues + a per-row map/sort
 * over the whole lane on every mount; the 152KB is the per-observation `body`.
 *
 * WI-7303 — two fixes that live together because both are in this mapper:
 *
 * 1. NULL KEYS ARE OMITTED (D-025). Measured live 2026-08-03 at 249,529 B / 200
 *    rows against a 250,000 B budget — 99.8% of ceiling — of which 9,600 B was
 *    literal `"k":null`: `kind`, `confidence` and `sourceRole` were null on
 *    200/200 rows. They are NOT structurally dead (corpus-wide, 14,613 rows:
 *    `observation.kind` on 1,637 and `.confidence` on 1,549, ~11% each), so
 *    omitting rather than dropping is the right shape — the key reappears the
 *    moment the data carries it. Every consumer read site is `??`/truthiness
 *    (ObservationsPanel.tsx), so ABSENT is indistinguishable from null there.
 *
 * 2. `sourceRole` READ THE WRONG KEY. This mapper took `payload.sourceRole`,
 *    which `capture-core.ts` writes — but the DOMINANT observation filer is
 *    turn-end reflection (loop:checkpoint / work_items:complete) routing through
 *    `checkpoint-harvest.ts`, which stamps `payload.filedByRole` and never
 *    `sourceRole`. Measured: `sourceRole` present on 82 of 14,613 observation
 *    rows (0.6%) and 0 of the newest 200; `filedByRole` on 200/200. So the
 *    pane's "Source role" column filter rendered '—' for every row while the
 *    attribution sat one key away — exactly the gap `filedByRole` was added to
 *    close (close-observation-attribution-gap 2026-06-21). Falls back, so the
 *    82 rows that DO carry `sourceRole` keep winning.
 *
 * `body` is 75.46% of the payload and is rendered for at most ONE row (the
 * expanded one) — but it backs the pane's client-side search across all 200, so
 * clipping it is a correctness regression, not a UI tweak. The next breach is
 * WI-7304 (on-demand body + server-side search), NOT a ceiling raise.
 */
import { attachListMeta } from './list-meta';
import { createReadDeadline } from './read-deadline';

/**
 * Whole-read deadline for this compute (WI-39823). 6s, the same budget the three
 * bounded learning.* reads carry and for the same measured reason: :3170 served
 * this family at p50 385ms / p90 599ms / max 1.24s (n=10), so 6s is ~10x headroom
 * at p90 while still firing well under both the sync layer's ~10s resolver timeout
 * and the memory backend's degraded p50 of ~10.9s (WI-39554).
 */
const OBSERVATIONS_READ_BUDGET_MS = 6_000;

export interface LearningObservationsArgs {
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
}

/** Options for {@link computeLearningObservations}. */
export interface LearningObservationsOpts {
  /** Whole-read deadline override in ms (default {@link OBSERVATIONS_READ_BUDGET_MS}). */
  budgetMs?: number;
}

/**
 * The wire row. The optional fields are OMITTED when null (D-025, WI-7303) —
 * `?: string` rather than `: string | null` so the type states what the wire
 * actually carries and a consumer cannot read absence as a bug.
 */
export interface LearningObservationRow {
  id: string;
  title: string;
  body?: string;
  kind?: string;
  scope?: string;
  confidence?: string;
  refs: string[];
  sourceRole?: string;
  createdAt: string;
}

/** Build the `learning.observations` rows (newest-first) with list `_meta` (total).
 *
 * BOUNDED (WI-39823). Both legs read the same `engineer_issues` store, and until
 * this bound they had neither a deadline NOR a `try`/`catch` — the weakest form of
 * the class fixed in the three sibling learning.* reads. A store that merely
 * HUNG (not threw) therefore held `Promise.all` past the sync layer's ~10s
 * resolver timeout, 500ing the pane; the client sets no `retry`, so TanStack's
 * default 3 attempts each paid that full timeout and the Observations pane sat on
 * a spinner for ~45s before its error branch could render — the same mechanism
 * behind the owner-reported "Loading retained items… forever".
 *
 * The two legs degrade DIFFERENTLY on purpose, because only one of them is data:
 *   • rows (`listIssues`) IS the read — there is no partial to ship, so a lapsed
 *     budget rejects, and it does so at ~6s instead of never. That is deliberately
 *     a faster failure and NOT a rescued render: the honest claim is that the
 *     error branch becomes reachable, not that the pane still fills.
 *   • count (`countIssues`) is only the "N of TOTAL" label — it fails soft, and
 *     `_meta.totalUnavailable` says so rather than letting the client read the
 *     downloaded length as if it were the true total (the exact misread
 *     `attachListMeta` exists to prevent).
 */
export async function computeLearningObservations(
  a: LearningObservationsArgs,
  opts: LearningObservationsOpts = {},
): Promise<LearningObservationRow[]> {
  const withinBudget = createReadDeadline(opts.budgetMs ?? OBSERVATIONS_READ_BUDGET_MS);
  const { listIssues, countIssues } = await import('../issues-engineer');
  // P-006/D-031: the `lane` column is the canonical observation identity; the topic
  // join under-reads (fenced to coordScopeWorkspace(), and 471 rows carry no tag).
  const { OBSERVATION_LANE } = await import('../harness/improvements/read-items');
  const filter = {
    lane: OBSERVATION_LANE,
    // D-003/P-004 (observation-lane-scorecard-classification-2026-08-16): the pane is
    // a RAW-observation browse feed — rubric-graded scorecards are completed verdicts
    // with their own surfaces (scorecards:list / rubrics:trend / plan acceptance) and
    // rendering them here as untriaged observations is the misread that opened the
    // 01a0031d investigation. Same predicate in the list and the count (parity).
    excludeRubricGraded: true,
    ...(a.state ? { state: a.state } : {}),
  };
  const [issues, total] = await Promise.all([
    withinBudget(listIssues({ ...filter, limit: a.limit ?? 200 }), 'observations rows'),
    withinBudget(countIssues(filter), 'observations count').catch(() => null),
  ]);
  const rows: LearningObservationRow[] = issues
    .map((i) => {
      const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
      const obs = p.observation && typeof p.observation === 'object' ? (p.observation as Record<string, unknown>) : {};
      const refs = Array.isArray(obs.refs) ? obs.refs.filter((r): r is string => typeof r === 'string') : [];
      // `filedByRole` is the fallback, not the primary: the 82 rows that carry a
      // real `sourceRole` (capture-core's P-010 tag) still win. See the header.
      const sourceRole =
        typeof p.sourceRole === 'string' ? p.sourceRole : typeof p.filedByRole === 'string' ? p.filedByRole : null;
      const scope = typeof obs.scope === 'string' ? obs.scope : (i.scope ?? null);
      // D-025: build the required keys, then attach the optional ones ONLY when
      // non-null — never `"k":null` on the wire.
      const row: LearningObservationRow = { id: i.id, title: i.title, refs, createdAt: i.createdAt };
      if (i.body != null) row.body = i.body;
      if (typeof obs.kind === 'string') row.kind = obs.kind;
      if (scope != null) row.scope = scope;
      if (typeof obs.confidence === 'string') row.confidence = obs.confidence;
      if (sourceRole != null) row.sourceRole = sourceRole;
      return row;
    })
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  // A degraded count must not be reported as a real one. `total: undefined` would
  // make the client fall back to the downloaded length and render it as the truth;
  // the explicit flag keeps "we don't know" distinguishable from "that is all".
  return attachListMeta(rows, total == null ? { totalUnavailable: true } : { total });
}
