/**
 * AdvEvalsTab — the /adv "Evaluation" tab (impartial-benchmark-suite-2026-06-15
 * D-007, BRIEF 9 / P-020).
 *
 * The dedicated home for the IMPARTIAL benchmark suite — the public, third-party
 * benchmark runs that prove the Papercusp harness contribution fairly (NOT the
 * self-referential internal evals: iq-battery / hive-eval / gym; those live in
 * the Learning tab). A skeptic discounts anything we author or grade, so this
 * surface reports runs on public tasks, graded by each benchmark's OFFICIAL
 * external grader, across four arms held to the same model / task / cost axis:
 *
 *   - `papercusp`           — the full multi-agent spine (the treatment).
 *   - `baseline-a-ablation` — the spine collapsed to a single worker (causal isolation).
 *   - `baseline-b-native`   — the same model in its native harness, best-elicited (headline, D-002).
 *   - `baseline-c-bestofn`  — single-agent best-of-N + verifier at matched budget.
 *
 * Sub-views (nuqs `?evalView=`):
 *   - **External benchmarks** (default): per-suite results + the cost/accuracy
 *     Pareto across arms (the P-021 `Frontier` viz drops in here).
 *   - **Internal trends**: the longitudinal view — how the suite score moves
 *     generation-over-generation (reuses `BenchmarkTrend`).
 *   - **Report**: the headline — pass@1 + CIs by arm and the system-delta vs
 *     each baseline (the P-021 `Compare` viz drops in here).
 *
 * State is URL-backed (nuqs, CLAUDE.md): `?evalView=` (subtab) · `?evalSuite=`
 * (selected benchmark suite) · `?evalRun=` (drill-in run id) — so deep links and
 * the agent `ui:dispatch` surface can drive it.
 *
 * Data: read-only via `@papercusp/sync`. The resolver entries are owned by the
 * schema co-owners, NOT this UI — `evals.suites` + `evals.runs` by P-010,
 * `evals.report` by P-011 (`@papercusp/bench-metrics` `buildSuiteReport`). This
 * tab is a pure CONSUMER. Schema locked v1 (`impartial-bench:run-result-schema:locked`):
 * canonical row type `TaskRunResult` + scoring `buildSuiteReport` live in
 * `@papercusp/bench-metrics`; PG is `benchmark_run_result` (migration 291).
 *
 * Sync-arg discipline (the invalidation-match gotcha): `emitRollout` fires
 * `notifySyncInvalidate('evals.runs', { run_id })`, so the runs/report queries
 * are keyed by `run_id` (NOT suite) or live invalidation silently won't refresh.
 * The suite picker resolves suite → latest `run_id` via `evals.suites`.
 *
 * Until those resolvers register + the first run lands, every query resolves to
 * `[]` and each subtab renders a clean empty state — this is the BRIEF 9 scaffold.
 */
import { useMemo } from 'react';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Trophy, Beaker, TrendingUp, FileText, RefreshCw, Gauge, Scale } from 'lucide-react';
import { Select } from '@/app/harness/Select';
// Shared, purely-presentational benchmark viz (P-021 / BRIEF 10). This tab owns
// the @papercusp/sync read and feeds these props; the components read no data.
import { Frontier, Compare, armLabel, type FrontierPoint, type ComparePerTaskRow } from '@/app/eval-viz';

// ── Arm vocabulary (LOCKED by P-011, su-4ac61) ───────────────────────────────
// These exact strings key the schema, the Pareto/delta math, and the viz series.
// Do NOT invent new labels — every arm-runner emits one of these.
const ARMS = ['papercusp', 'baseline-a-ablation', 'baseline-b-native', 'baseline-c-bestofn'] as const;
type ArmId = (typeof ARMS)[number];

const ARM_LABEL: Record<ArmId, string> = {
  papercusp: 'Papercusp',
  'baseline-a-ablation': 'A · ablation',
  'baseline-b-native': 'B · native',
  'baseline-c-bestofn': 'C · best-of-N',
};
const ARM_HINT: Record<ArmId, string> = {
  papercusp: 'The full multi-agent spine — the treatment under test.',
  'baseline-a-ablation': 'The spine collapsed to a single worker, identical tools/model/budget — the causal-isolation control.',
  'baseline-b-native': 'The same model in its native harness (e.g. Claude Code), best-elicited — the headline baseline.',
  'baseline-c-bestofn': 'A single agent sampled N times + a test-verifier, at matched token budget.',
};
const ARM_COLOR: Record<ArmId, string> = {
  papercusp: '#eab308',
  'baseline-a-ablation': '#a78bfa',
  'baseline-b-native': '#38bdf8',
  'baseline-c-bestofn': '#34d399',
};

// ── Consumer-side shapes (placeholder) ───────────────────────────────────────
// TODO(P-010/P-011): replace these locals with the canonical `TaskRunResult` +
// report types imported from `@papercusp/bench-metrics/schema` once the schema is
// broadcast (`impartial-bench:run-result-schema:locked`). Kept minimal + lenient
// so additive column changes don't break the scaffold.
interface EvalSuiteSummary {
  suite: string;
  runId: string | null;
  taskCount: number;
  armCount: number;
  /** pass@1 (0–1) per arm for the latest run, if computed. */
  passAt1ByArm?: Partial<Record<ArmId, number>>;
  updatedAt?: string | null;
}
interface EvalArmAggregate {
  arm: ArmId;
  passAt1: number;
  ci?: [number, number];
  costUsd?: number;
  isoBudgetTokens?: number | null;
}
interface EvalReport {
  suite: string;
  byArm: EvalArmAggregate[];
  /** System-delta vs each baseline (papercusp − baseline). */
  deltas?: Array<{ baseline: ArmId; deltaPassAt1: number; costRatio: number | null }>;
}

// One per-(task × arm × seed) row from `evals.runs`. camelCase mirror of the
// `benchmark_run_result` PG row. TODO(P-011): replace with the canonical
// `TaskRunResult` from `@papercusp/bench-metrics/schema` once it is importable.
interface EvalRunRow {
  taskId: string;
  arm: ArmId | string;
  seed: number;
  /** null = infra error (excluded from accuracy), per the locked scoring rules. */
  resolved: boolean | null;
  costUsd?: number | null;
  tokensTotal?: number | null;
}

const EVAL_VIEWS = ['external', 'internal', 'report'] as const;
type EvalView = (typeof EVAL_VIEWS)[number];

const pctLabel = (v: number | null | undefined): string => (v == null ? '—' : `${Math.round(v * 100)}%`);

// ── Mappers: sync data → viz props (presentation only; stats stay in P-011) ───

/** Per-arm cost/accuracy points for the Frontier — one point per arm, from the
 *  report's per-arm aggregate (pass@1 + derived cost). */
function toFrontierPoints(report: EvalReport | undefined): FrontierPoint[] {
  if (!report) return [];
  return report.byArm
    .filter((a) => a.costUsd != null)
    .map((a) => ({ label: armLabel(a.arm), cost: a.costUsd as number, score: a.passAt1, arm: a.arm }));
}

/** Per-task pass@1 pivot for the A/B table: mean(resolved over seeds) per (task,
 *  arm). Presentation-level grouping only — the cross-task pass@k statistics
 *  stay in P-011's `buildSuiteReport`; this just lays raw rows side by side. */
function toComparePerTask(rows: EvalRunRow[], baseline: string, treatment: string): ComparePerTaskRow[] {
  const byTask = new Map<string, { b: number[]; t: number[] }>();
  for (const r of rows) {
    if (r.resolved == null) continue; // infra error — excluded from accuracy
    const bucket = byTask.get(r.taskId) ?? { b: [], t: [] };
    if (r.arm === baseline) bucket.b.push(r.resolved ? 1 : 0);
    else if (r.arm === treatment) bucket.t.push(r.resolved ? 1 : 0);
    byTask.set(r.taskId, bucket);
  }
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);
  return [...byTask.entries()]
    .map(([label, v]) => ({ label, baseline: mean(v.b), treatment: mean(v.t) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The three baselines, headline-first (B native is the headline, D-002). */
const BASELINE_ARMS: ArmId[] = ['baseline-b-native', 'baseline-a-ablation', 'baseline-c-bestofn'];
const fmtPct = (n: number | null | undefined): string => (n == null ? '—' : `${Math.round(n * 100)}%`);
const fmtUsd = (n: number): string => `$${n >= 100 ? Math.round(n) : Math.round(n * 100) / 100}`;

export default function AdvEvalsTab() {
  const [evalView, setEvalView] = useQueryState(
    'evalView',
    parseAsStringEnum<EvalView>([...EVAL_VIEWS]).withDefault('external'),
  );
  const [evalSuite, setEvalSuite] = useQueryState('evalSuite', parseAsString);
  const [evalRun, setEvalRun] = useQueryState('evalRun', parseAsString);
  const view: EvalView = (EVAL_VIEWS as readonly string[]).includes(evalView) ? evalView : 'external';

  // The suite picker is shared across all three views — fetched once.
  const suitesSync = useSyncQuery<EvalSuiteSummary>({
    queryName: 'evals.suites',
    args: {},
    staleTime: 30_000,
  });
  const suites = suitesSync.data ?? [];
  // Default-select the first suite once the list loads (a fresh tab lands on a
  // real suite without writing the URL until the user picks).
  const activeSuite = evalSuite || suites[0]?.suite || '';
  const activeSummary = useMemo(() => suites.find((s) => s.suite === activeSuite), [suites, activeSuite]);
  // The runs/report queries key on run_id (matches emitRollout's invalidate). A
  // `?evalRun=` drill-in wins; else the suite's latest run.
  const runId = evalRun || activeSummary?.runId || '';

  return (
    <div className="pc-evals">
      <header className="pc-evals__header">
        <div className="pc-evals__copy">
          <h1>
            <Trophy size={18} aria-hidden /> Evaluation
          </h1>
          <p>
            The <strong>impartial</strong> benchmark suite — public third-party tasks, graded by each benchmark’s
            <em> official external grader</em>, run across four arms held to the same model, task set, and cost axis.
            This is the honest systems claim: holding the model constant, how much does the Papercusp harness add, and
            at what cost? (The self-referential internal evals — gym, IQ-battery, hive-eval — live under{' '}
            <a className="pc-evals__link" href="/adv?tab=learning">Learning</a>.)
          </p>
        </div>
        <ArmLegend />
      </header>

      <div className="pc-evals__controls">
        <div className="pc-evals__subnav" role="tablist" aria-label="Evaluation view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'external'}
            className={`pc-evals__subtab${view === 'external' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('external')}
          >
            <Beaker size={13} aria-hidden />
            <span>External benchmarks<em>public · graded fairly</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'internal'}
            className={`pc-evals__subtab${view === 'internal' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('internal')}
          >
            <TrendingUp size={13} aria-hidden />
            <span>Internal trends<em>score over time</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'report'}
            className={`pc-evals__subtab${view === 'report' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('report')}
          >
            <FileText size={13} aria-hidden />
            <span>Report<em>headline + deltas</em></span>
          </button>
        </div>
        <div className="pc-evals__controlsright">
          {/* Suite picker — shared across views; hidden until suites exist. */}
          {suites.length > 0 ? (
            <label className="pc-evals__suitepick" title="The benchmark family to view (SWE-bench Pro, Terminal-Bench, …).">
              <Gauge size={12} aria-hidden />
              <span className="pc-evals__suitelabel">suite</span>
              <Select
                ariaLabel="Benchmark suite"
                value={activeSuite}
                onChange={(v: string) => {
                  void setEvalSuite(v);
                  // A suite switch invalidates the drill-in run selection.
                  void setEvalRun(null);
                }}
                triggerStyle={{ maxWidth: 220 }}
                options={suites.map((s) => ({
                  value: s.suite,
                  label: `${s.suite}${s.taskCount ? ` · ${s.taskCount} tasks` : ''}`,
                }))}
              />
            </label>
          ) : null}
          <button
            type="button"
            className="pc-evals__refresh"
            aria-label="Reload the evaluation data"
            disabled={suitesSync.fetching}
            onClick={() => suitesSync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        </div>
      </div>

      {view === 'internal' ? (
        <InternalTrendsView suite={activeSuite} suites={suites} suitesLoading={suitesSync.loading && !suitesSync.data} />
      ) : view === 'report' ? (
        <ReportView suite={activeSuite} runId={runId} />
      ) : (
        <ExternalBenchmarksView
          suite={activeSuite}
          runId={runId}
          summary={activeSummary}
          suites={suites}
          suitesLoading={suitesSync.loading && !suitesSync.data}
        />
      )}

      <EvalsStyles />
    </div>
  );
}

// ── Arm legend (the four arms + what each isolates) ──────────────────────────

function ArmLegend() {
  return (
    <div className="pc-evals__legend" aria-label="Benchmark arms">
      {ARMS.map((arm) => (
        <span key={arm} className="pc-evals__legenditem" title={ARM_HINT[arm]}>
          <span className="pc-evals__legenddot" style={{ background: ARM_COLOR[arm] }} aria-hidden />
          {ARM_LABEL[arm]}
        </span>
      ))}
    </div>
  );
}

// ── External benchmarks view (per-suite results + cost/accuracy Pareto) ───────

function ExternalBenchmarksView({
  suite,
  runId,
  summary,
  suites,
  suitesLoading,
}: {
  suite: string;
  runId: string;
  summary: EvalSuiteSummary | undefined;
  suites: EvalSuiteSummary[];
  suitesLoading: boolean;
}) {
  // Per-(task × arm × seed) rows for the selected run. Keyed by run_id to match
  // emitRollout's notifySyncInvalidate('evals.runs', { run_id }). Feeds the
  // cost/accuracy Pareto (P-021 Frontier) + the scoreboard.
  const runsSync = useSyncQuery<unknown>({
    queryName: 'evals.runs',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  const rows = runsSync.data ?? [];

  if (suitesLoading) {
    return <p className="pc-evals__empty">Loading benchmark suites…</p>;
  }

  if (suites.length === 0) {
    return (
      <EmptyCard
        icon={<Trophy size={20} aria-hidden />}
        title="No benchmark runs yet"
        body="Once the external-bench adapter runs a suite (SWE-bench Pro, Terminal-Bench, …) across the four arms, each suite’s results appear here — per-arm pass@1, the cost/accuracy Pareto, and the headline system-delta. Runs are graded by the benchmark’s official external grader, never by us."
      />
    );
  }

  return (
    <section className="pc-evals__section">
      {/* Per-arm pass@1 scoreboard for the latest run of this suite. */}
      <div className="pc-evals__scoreboard" aria-label={`${suite} — pass@1 by arm`}>
        {ARMS.map((arm) => (
          <ArmStat
            key={arm}
            arm={arm}
            value={pctLabel(summary?.passAt1ByArm?.[arm])}
            hint={`pass@1 for ${ARM_LABEL[arm]} on ${suite || 'this suite'}. ${ARM_HINT[arm]}`}
          />
        ))}
      </div>

      {/* Cost/accuracy Pareto — the P-021 Frontier viz mounts here, fed by `rows`
          shaped as { label, cost, score, arm } points. Until that component lands
          (events:await eval-viz:components:ready), render a clean placeholder. */}
      <div className="pc-evals__sectionhead">
        <h2>Cost / accuracy frontier</h2>
        <button
          type="button"
          className="pc-evals__refresh"
          aria-label="Reload the runs"
          disabled={runsSync.fetching}
          onClick={() => runsSync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      <div className="pc-evals__vizmount" data-eval-viz="pareto" role="img" aria-label="Cost vs accuracy Pareto (pending data)">
        {/* P-021: import { Frontier } from '@/app/eval-viz/Frontier';
            <Frontier points={toFrontierPoints(rows)} /> */}
        {runsSync.loading && !runsSync.data ? (
          <p className="pc-evals__empty">Loading runs…</p>
        ) : rows.length === 0 ? (
          <EmptyCard
            icon={<Gauge size={20} aria-hidden />}
            title="No runs for this suite yet"
            body="When this suite is run across the arms, each arm plots as a point — accuracy (pass@1) against total cost (all tokens, coordination overhead included). The honest systems claim is the arm that sits up-and-to-the-left of the native baseline."
          />
        ) : (
          <p className="pc-evals__empty">{rows.length} run rows loaded — Pareto viz (P-021) wires in here.</p>
        )}
      </div>
    </section>
  );
}

// ── Internal trends view (longitudinal score over generations) ───────────────

function InternalTrendsView({
  suite,
  suites,
  suitesLoading,
}: {
  suite: string;
  suites: EvalSuiteSummary[];
  suitesLoading: boolean;
}) {
  // The longitudinal trend (suite score per code generation) is derived from the
  // suite history. The parent already fetches `evals.suites` via sync, so this
  // view consumes that rather than firing a second query. A dedicated longitudinal
  // query (e.g. `evals.suites` carrying run history, or a future `evals.trend`)
  // is a P-010/P-011 follow-on; once it carries ≥2 generations, reuse the existing
  // BenchmarkTrend surface here (as the Learning tab does).
  const generations = suites.filter((s) => s.suite === suite);

  if (suitesLoading) {
    return <p className="pc-evals__empty">Loading…</p>;
  }

  return (
    <section className="pc-evals__section">
      <div className="pc-evals__sectionhead">
        <h2>Score over time {suite ? <em>{suite}</em> : null}</h2>
      </div>
      {generations.length < 2 ? (
        <EmptyCard
          icon={<TrendingUp size={20} aria-hidden />}
          title="No trend yet"
          body="Each time this suite is re-run against a new code generation, its per-arm pass@1 becomes one point on the trend — the proof that the harness (and the gym tuning it) is actually getting better over time. Two or more generations are needed before a line appears."
        />
      ) : (
        <p className="pc-evals__empty">{generations.length} generations — trend viz (BenchmarkTrend) wires in here.</p>
      )}
    </section>
  );
}

// ── Report view (headline pass@1 + CIs + system-delta vs each baseline) ───────

function ReportView({ suite, runId }: { suite: string; runId: string }) {
  // The headline aggregate for this run — pass@1 + Wilson CI by arm + the
  // system-delta vs each baseline (P-011 `buildSuiteReport`). Keyed by run_id to
  // match emitRollout's invalidation.
  const reportSync = useSyncQuery<EvalReport>({
    queryName: 'evals.report',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  const report = reportSync.data?.[0];

  return (
    <section className="pc-evals__section">
      <div className="pc-evals__sectionhead">
        <h2>Headline report {suite ? <em>{suite}</em> : null}</h2>
        <button
          type="button"
          className="pc-evals__refresh"
          aria-label="Reload the report"
          disabled={reportSync.fetching}
          onClick={() => reportSync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {reportSync.loading && !reportSync.data ? (
        <p className="pc-evals__empty">Loading the report…</p>
      ) : !report ? (
        <EmptyCard
          icon={<Scale size={20} aria-hidden />}
          title="No report yet"
          body="Once a suite has been run across all four arms with ≥3 seeds, the headline lands here: pass@1 with a 95% confidence interval per arm, the iso-budget cost, and the system-delta — “holding the model constant, the Papercusp harness resolves X% more at Z% of the native-harness cost.” The per-baseline A/B/C deltas (P-021 Compare) plot below."
        />
      ) : (
        <>
          <div className="pc-evals__scoreboard" aria-label={`${suite} — headline pass@1 by arm`}>
            {report.byArm.map((a) => (
              <ArmStat
                key={a.arm}
                arm={a.arm}
                value={pctLabel(a.passAt1)}
                sub={a.ci ? `${pctLabel(a.ci[0])}–${pctLabel(a.ci[1])}` : undefined}
                hint={`pass@1 (95% CI) for ${ARM_LABEL[a.arm]}. ${ARM_HINT[a.arm]}`}
              />
            ))}
          </div>
          {/* P-021: import { Compare } from '@/app/eval-viz/Compare';
              <Compare baseline="baseline-b-native" treatment="papercusp" perTask={...} /> */}
          <div className="pc-evals__vizmount" data-eval-viz="compare" role="img" aria-label="System-delta vs baselines (pending viz)">
            <p className="pc-evals__empty">System-delta viz (P-021 Compare) wires in here.</p>
          </div>
        </>
      )}
    </section>
  );
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function ArmStat({
  arm,
  value,
  sub,
  hint,
}: {
  arm: ArmId;
  value: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <div className="pc-evals__stat" title={hint} style={{ ['--arm-accent' as string]: ARM_COLOR[arm] }}>
      <span className="pc-evals__statlabel">
        <span className="pc-evals__statdot" aria-hidden />
        {ARM_LABEL[arm]}
      </span>
      <span className="pc-evals__statvalue">{value}</span>
      {sub ? <span className="pc-evals__statsub">{sub}</span> : null}
    </div>
  );
}

function EmptyCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="pc-evals__empty pc-evals__empty--card">
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

// ── Scoped styles (shared app tokens — matches AdvShell / LearningTab) ────────

function EvalsStyles() {
  return (
    <style>{`
      .pc-evals { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 28px; min-height: 0; }
      .pc-evals__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
      .pc-evals__copy { min-width: 0; max-width: 760px; display: grid; gap: 6px; }
      .pc-evals__copy h1 { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 20px; font-weight: 760; letter-spacing: -0.02em; color: var(--fg, #e7f7ff); }
      .pc-evals__copy p { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--fg-dim, #b9d4e8); }
      .pc-evals__copy em { font-style: italic; color: var(--fg, #e7f7ff); }
      .pc-evals__link { color: var(--accent, #38bdf8); text-decoration: none; }
      .pc-evals__link:hover { text-decoration: underline; }

      .pc-evals__legend { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; flex-shrink: 0; }
      .pc-evals__legenditem { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); white-space: nowrap; cursor: default; }
      .pc-evals__legenddot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

      .pc-evals__controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border, rgba(125,211,252,0.15)); padding-bottom: 10px; }
      .pc-evals__subnav { display: inline-flex; gap: 6px; flex-wrap: wrap; }
      .pc-evals__subtab { display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: 9px; border: 1px solid var(--border, rgba(125,211,252,0.18)); background: var(--bg-2, rgba(255,255,255,0.04)); color: var(--fg-mute, #7f9bb4); font-size: 12px; font-weight: 650; cursor: pointer; }
      .pc-evals__subtab em { display: block; font-style: normal; font-size: 9.5px; font-weight: 600; opacity: 0.72; margin-top: 1px; }
      .pc-evals__subtab:hover { color: var(--fg, #e7f7ff); }
      .pc-evals__subtab.is-active { color: var(--fg, #e7f7ff); border-color: color-mix(in oklab, #eab308, transparent 30%); background: color-mix(in oklab, #eab308, transparent 86%); }
      .pc-evals__controlsright { display: inline-flex; align-items: center; gap: 10px; }
      .pc-evals__suitepick { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-mute, #7f9bb4); }
      .pc-evals__suitelabel { font-size: 10px; font-weight: 760; letter-spacing: 0.08em; text-transform: uppercase; }
      .pc-evals__refresh { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--border, rgba(125,211,252,0.2)); background: var(--bg-2, rgba(255,255,255,0.04)); color: var(--fg-dim, #b9d4e8); cursor: pointer; }
      .pc-evals__refresh:disabled { opacity: 0.5; cursor: default; }

      .pc-evals__section { display: flex; flex-direction: column; gap: 14px; }
      .pc-evals__sectionhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .pc-evals__sectionhead h2 { margin: 0; font-size: 14px; font-weight: 700; color: var(--fg, #e7f7ff); display: inline-flex; align-items: baseline; gap: 8px; }
      .pc-evals__sectionhead em { font-style: italic; font-size: 11px; font-weight: 600; color: var(--fg-mute, #7f9bb4); }

      .pc-evals__scoreboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
      .pc-evals__stat { display: grid; gap: 4px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border, rgba(125,211,252,0.18)); background: var(--bg-2, rgba(255,255,255,0.04)); border-left: 3px solid var(--arm-accent, var(--accent, #38bdf8)); }
      .pc-evals__statlabel { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-evals__statdot { width: 7px; height: 7px; border-radius: 50%; background: var(--arm-accent, var(--accent, #38bdf8)); flex-shrink: 0; }
      .pc-evals__statvalue { font-size: 22px; font-weight: 760; color: var(--fg, #e7f7ff); line-height: 1; }
      .pc-evals__statsub { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

      .pc-evals__vizmount { min-height: 180px; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--border, rgba(125,211,252,0.22)); border-radius: 12px; padding: 16px; }

      .pc-evals__empty { font-size: 12px; color: var(--fg-mute, #7f9bb4); margin: 0; text-align: center; }
      .pc-evals__empty--card { display: grid; justify-items: center; gap: 8px; max-width: 560px; margin: 8px auto; padding: 22px; color: var(--fg-mute, #7f9bb4); }
      .pc-evals__empty--card strong { font-size: 14px; color: var(--fg, #e7f7ff); }
      .pc-evals__empty--card span { font-size: 12px; line-height: 1.55; }
    `}</style>
  );
}
