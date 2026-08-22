"use client";

/**
 * RubricDetailPanel — a single rubric's grading history + per-criterion trend
 * (rubrics-tab-scorecard-ui-2026-07-09 P-002). Reads the already-live
 * `scorecards.list` + `rubrics.trend` sync queries (the SAME store reads
 * scorecards:list / rubrics:trend serve agents). Clicking a scorecard row
 * opens the full ScorecardDetail (P-003) — no extra fetch, the list rows
 * already carry the complete ratings map.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSyncQuery } from "@papercusp/sync";
import type { CompanionListSummary } from "@papercusp/facets";
import { readListMeta } from "@papercusp/operator-core/lib/sync-resolver/list-meta";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, Minus, TrendingDown, TrendingUp, X } from "lucide-react";
import { Table, type TableColumn } from "../harness/Table";
import { filterCountLabel, type CountEvidence } from "../harness/filters";
import ScorecardDetail, {
  RatingChip,
  type ScorecardRow,
} from "./ScorecardDetail";

interface CriterionTrend {
  criterion: string;
  count: number;
  distribution: Record<string, number>;
  idleCount: number;
  first: { rating: string; at: string };
  latest: { rating: string; at: string };
  direction: string;
  mean10: number | null;
  // WI-4607: the criterion's instrument binding, parsed from a trailing
  // [instrumentKey: <key>|none] token on the rubric criterion's model prose.
  instrumentKey?: string | null;
}

interface RubricTrend {
  rubricRef: string;
  scorecardCount: number;
  sample: { limit: number; inputCount: number };
  window: { since?: string; from?: string; to?: string };
  criteria: CriterionTrend[];
  // WI-4607 governance provenance (D-012): the same author≠ratifier story the
  // RubricsPanel list surfaces, threaded through the rubrics.trend resolver.
  status?: string;
  proposedBy?: string | null;
  ratifiedBy?: string | null;
}

const SCORECARD_HISTORY_PAGE = 100;

/** Page one replaces; cursor pages append idempotently by scorecard identity. */
export function mergeScorecardHistoryPage(
  previous: readonly ScorecardRow[],
  page: readonly ScorecardRow[],
  cursor: string | null,
): ScorecardRow[] {
  if (!cursor) return [...page];
  const byId = new Map(previous.map((row) => [row.issueId, row] as const));
  for (const row of page) byId.set(row.issueId, row);
  return [...byId.values()];
}

function isActive(status: string): boolean {
  return status === "active" || status === "ratified";
}
function awaitsRatification(status: string): boolean {
  return status === "proposed" || status === "draft";
}

/** Shorten a long agent ownerId (su-eb9b7ae3-…) to a stable, readable handle. */
function shortActor(actor: string | null): string {
  if (!actor) return "—";
  const m = /^([a-z]+-[0-9a-f]{4,8})/i.exec(actor);
  return m ? m[1] : actor.length > 16 ? `${actor.slice(0, 15)}…` : actor;
}

function directionGlyph(direction: string): string {
  const d = direction.toLowerCase();
  if (d.includes("improv") || d.includes("up")) return "↑";
  if (
    d.includes("worsen") ||
    d.includes("declin") ||
    d.includes("regress") ||
    d.includes("down")
  )
    return "↓";
  return "→";
}

/** Per-glyph icon + tone-color + human word for the Trend column (owner ask
 *  2026-07-19, WI-5415): the prose ("improving"/"stable"/…) was easy to skim
 *  past — a very visible colored icon reads at a glance. The word survives in
 *  the aria-label + title tooltip, never dropped, just no longer the primary
 *  visible content. */
const TREND_GLYPH_ICON: Record<
  string,
  { Icon: typeof TrendingUp; color: string }
> = {
  "↑": { Icon: TrendingUp, color: "#34d399" },
  "↓": { Icon: TrendingDown, color: "#fb7185" },
  "→": { Icon: Minus, color: "#64748b" },
};

function TrendIndicator({ direction }: { direction: string }) {
  const glyph = directionGlyph(direction);
  const { Icon, color } = TREND_GLYPH_ICON[glyph] ?? TREND_GLYPH_ICON["→"];
  return (
    <span
      className="pc-rubric-trend__dir"
      role="img"
      aria-label={direction}
      title={direction}
    >
      <Icon size={14} color={color} strokeWidth={2.5} aria-hidden />
    </span>
  );
}

function formatDistribution(distribution: Record<string, number>): string {
  return Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .map(([rating, n]) => `${n}× ${rating}`)
    .join(", ");
}

function distributionTone(rating: string): string {
  const normalized = rating.toLowerCase();
  if (/healthy|good|strong|excellent|pass|complete/.test(normalized))
    return "good";
  if (/degraded|warn|partial|inconclusive/.test(normalized)) return "warn";
  if (/broken|bad|fail|regress/.test(normalized)) return "bad";
  if (/unknown|unrated|idle/.test(normalized)) return "neutral";
  return "accent";
}

function DistributionBar({
  distribution,
  count,
}: {
  distribution: Record<string, number>;
  count: number;
}) {
  const entries = Object.entries(distribution)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const label = formatDistribution(distribution);
  return (
    <span
      className="pc-rubric-distribution"
      role="img"
      aria-label={`${label}; ${count} rated`}
      title={`${label} · ${count} rated`}
    >
      <span className="pc-rubric-distribution__track" aria-hidden>
        {entries.map(([rating, value]) => (
          <i
            key={rating}
            data-tone={distributionTone(rating)}
            style={{ width: `${total > 0 ? (value / total) * 100 : 0}%` }}
          />
        ))}
      </span>
      <strong>{count}</strong>
    </span>
  );
}

export default function RubricDetailPanel({
  rubricId,
  onBack,
}: {
  rubricId: string;
  onBack?: () => void;
}) {
  const [selected, setSelected] = useState<ScorecardRow | null>(null);
  const [stableOpen, setStableOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<ScorecardRow[]>([]);
  const [nextHistoryCursor, setNextHistoryCursor] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setSelected(null);
    setHistoryCursor(null);
    setHistoryRows([]);
    setNextHistoryCursor(null);
  }, [rubricId]);

  const scorecards = useSyncQuery<ScorecardRow>({
    queryName: "scorecards.list",
    args: {
      rubricRef: rubricId,
      limit: SCORECARD_HISTORY_PAGE,
      ...(historyCursor ? { cursor: historyCursor } : {}),
    },
  });
  const scorecardSummary = useSyncQuery<CompanionListSummary>({
    queryName: "scorecards.summary",
    args: { rubricRef: rubricId },
  });
  const trend = useSyncQuery<RubricTrend>({
    queryName: "rubrics.trend",
    args: { rubricRef: rubricId },
  });

  useEffect(() => {
    if (scorecards.loading || scorecards.fetching || !scorecards.data) return;
    setHistoryRows((previous) =>
      mergeScorecardHistoryPage(previous, scorecards.data!, historyCursor),
    );
    const meta = readListMeta(scorecards.data);
    setNextHistoryCursor(
      typeof meta?.nextCursor === "string" ? meta.nextCursor : null,
    );
  }, [scorecards.data, scorecards.loading, scorecards.fetching, historyCursor]);

  const rows = historyRows.length > 0 ? historyRows : (scorecards.data ?? []);
  const summary = scorecardSummary.data?.[0] ?? null;
  const pairedFetching = Boolean(
    scorecards.fetching ||
    scorecards.loading ||
    scorecardSummary.fetching ||
    scorecardSummary.loading,
  );
  const trendRow = trend.data?.[0];
  const corpusEvidence = useMemo<CountEvidence>(() => {
    if (scorecardSummary.error) return { kind: "unknown", reason: "failed" };
    if (pairedFetching) return { kind: "unknown", reason: "updating" };
    if (!summary) return { kind: "unknown", reason: "loading" };
    return {
      kind: "corpus",
      count: summary.matched,
      population: `scorecards filed against ${rubricId}`,
    };
  }, [scorecardSummary.error, pairedFetching, summary, rubricId]);
  const loadedHistoryEvidence = useMemo<CountEvidence>(() => {
    if (pairedFetching) return { kind: "unknown", reason: "updating" };
    if (scorecards.error) return { kind: "unknown", reason: "failed" };
    return {
      kind: "window",
      count: rows.length,
      window: "loaded history pages",
      ...(summary ? { corpusTotal: summary.matched } : {}),
    };
  }, [pairedFetching, scorecards.error, rows.length, summary]);
  const trendSampleEvidence = useMemo<CountEvidence>(() => {
    if (trend.error) return { kind: "unknown", reason: "failed" };
    if (trend.loading || trend.fetching) {
      return { kind: "unknown", reason: "updating" };
    }
    if (!trendRow) return { kind: "unknown", reason: "unavailable" };
    const inputCount = trendRow.sample.inputCount;
    return {
      kind: "window",
      count: trendRow.scorecardCount,
      window: `latest ${inputCount} scorecards (cap ${trendRow.sample.limit})`,
      windowTotal: inputCount,
      ...(!pairedFetching && summary ? { corpusTotal: summary.matched } : {}),
    };
  }, [
    trend.error,
    trend.loading,
    trend.fetching,
    trendRow,
    pairedFetching,
    summary,
  ]);
  const corpusCountLabel = useMemo(
    () => filterCountLabel(corpusEvidence, "scorecard"),
    [corpusEvidence],
  );
  const loadedHistoryLabel = useMemo(
    () => filterCountLabel(loadedHistoryEvidence, "scorecard"),
    [loadedHistoryEvidence],
  );
  const trendSampleLabel = useMemo(
    () => filterCountLabel(trendSampleEvidence, "scorecard"),
    [trendSampleEvidence],
  );
  const loadOlder = useCallback(() => {
    if (nextHistoryCursor) setHistoryCursor(nextHistoryCursor);
  }, [nextHistoryCursor]);

  if (selected) {
    return (
      <ScorecardDetail scorecard={selected} onBack={() => setSelected(null)} />
    );
  }

  const scoredCriteria =
    trendRow?.criteria.filter((criterion) => criterion.mean10 != null) ?? [];
  const mean =
    scoredCriteria.length > 0
      ? scoredCriteria.reduce(
          (sum, criterion) => sum + (criterion.mean10 ?? 0),
          0,
        ) / scoredCriteria.length
      : null;
  const improving =
    trendRow?.criteria.filter(
      (criterion) => directionGlyph(criterion.direction) === "↑",
    ).length ?? 0;
  const regressing =
    trendRow?.criteria.filter(
      (criterion) => directionGlyph(criterion.direction) === "↓",
    ).length ?? 0;
  const priorityCriteria =
    trendRow?.criteria
      .filter((criterion) => directionGlyph(criterion.direction) !== "→")
      .sort((a, b) => {
        const rank = (criterion: CriterionTrend) =>
          directionGlyph(criterion.direction) === "↓" ? 0 : 1;
        return rank(a) - rank(b) || a.criterion.localeCompare(b.criterion);
      }) ?? [];
  const stableCriteria =
    trendRow?.criteria
      .filter((criterion) => directionGlyph(criterion.direction) === "→")
      .sort((a, b) => a.criterion.localeCompare(b.criterion)) ?? [];

  const trendColumns: TableColumn<CriterionTrend>[] = trendRow
    ? [
        {
          key: "criterion",
          header: "Criterion",
          render: (c) => (
            <span className="pc-rubric-trend__crit">
              {c.criterion}
              {c.instrumentKey ? (
                <em
                  className="pc-rubric-trend__instr"
                  data-none={c.instrumentKey === "none" ? "" : undefined}
                  title={
                    c.instrumentKey === "none"
                      ? "No measuring instrument bound to this criterion (explicit [instrumentKey: none])"
                      : `Instrument: ${c.instrumentKey}`
                  }
                >
                  {c.instrumentKey}
                </em>
              ) : null}
            </span>
          ),
          cellStyle: { whiteSpace: "nowrap" },
        },
        {
          key: "latest",
          header: "Latest",
          render: (c) => <RatingChip rating={c.latest.rating} />,
        },
        {
          key: "trend",
          header: "Trend",
          render: (c) => <TrendIndicator direction={c.direction} />,
          cellTitle: (c) => c.direction,
        },
        {
          key: "mean",
          header: "Mean /10",
          render: (c) => c.mean10 ?? "—",
          cellStyle: { fontVariantNumeric: "tabular-nums" },
        },
        {
          key: "distribution",
          header: "Distribution",
          render: (c) => (
            <DistributionBar distribution={c.distribution} count={c.count} />
          ),
        },
      ]
    : [];

  const historyColumns: TableColumn<ScorecardRow>[] = [
    { key: "scorecard", header: "Scorecard", render: (row) => row.issueId },
    {
      key: "gradedAt",
      header: "Graded at",
      render: (row) => new Date(row.createdAt).toLocaleString(),
      cellStyle: { whiteSpace: "nowrap" },
    },
    {
      key: "gradedBy",
      header: "Graded by",
      render: (row) => row.createdBy ?? "unknown",
    },
    {
      key: "score",
      header: "Score /10",
      render: (row) => row.score10 ?? "—",
      cellStyle: { fontVariantNumeric: "tabular-nums" },
    },
    {
      key: "criteriaRated",
      header: "Criteria rated",
      render: (row) => row.nKeys,
      cellStyle: { fontVariantNumeric: "tabular-nums" },
    },
    {
      key: "completeness",
      header: "Completeness",
      render: (row) =>
        row.rubricResolved
          ? row.missingKeys.length === 0
            ? "complete"
            : `${row.missingKeys.length} missing`
          : "rubric unresolved",
    },
  ];

  return (
    <div className="pc-rubric-detail">
      <header className="pc-rubric-detail__head">
        <span>Evidence</span>
        <strong>{rubricId}</strong>
        {trendRow ? (
          <div
            className={`pc-rubric-detail__gov pc-rubric-detail__gov--${
              isActive(trendRow.status ?? "")
                ? "active"
                : awaitsRatification(trendRow.status ?? "")
                  ? "awaiting"
                  : "inactive"
            }`}
          >
            <span className="pc-rubric-detail__gov-status">
              {isActive(trendRow.status ?? "")
                ? "Active"
                : awaitsRatification(trendRow.status ?? "")
                  ? "Awaiting ratification"
                  : (trendRow.status ?? "—")}
            </span>
            <span
              className="pc-rubric-detail__gov-chain"
              title={`proposed by ${trendRow.proposedBy ?? "unknown"}${
                trendRow.ratifiedBy
                  ? ` · ratified by ${trendRow.ratifiedBy}`
                  : ""
              }`}
            >
              <em>prop</em> {shortActor(trendRow.proposedBy ?? null)}
              {isActive(trendRow.status ?? "") ? (
                <>
                  {" "}
                  <em>· ratif</em> {shortActor(trendRow.ratifiedBy ?? null)}
                  {trendRow.ratifiedBy &&
                  trendRow.proposedBy &&
                  trendRow.ratifiedBy !== trendRow.proposedBy ? (
                    <span
                      className="pc-rubric-detail__gov-split"
                      title="Independent ratifier — author ≠ ratifier (D-012)"
                    >
                      ✓ split
                    </span>
                  ) : null}
                </>
              ) : null}
            </span>
          </div>
        ) : null}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Close rubric evidence"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </header>

      <div className="pc-rubric-detail__overview" aria-label="Rubric summary">
        <div className="pc-rubric-detail__hero">
          <span>Mean</span>
          <strong>{mean == null ? "—" : mean.toFixed(1)}</strong>
          <small>/10</small>
        </div>
        <div>
          <span>Scorecards</span>
          <strong
            data-evidence={corpusCountLabel.evidence}
            aria-label={corpusCountLabel.ariaLabel}
          >
            {corpusCountLabel.title}
          </strong>
        </div>
        <div className="is-good">
          <span>Improving</span>
          <strong>{improving}</strong>
        </div>
        <div className={regressing > 0 ? "is-bad" : undefined}>
          <span>Regressing</span>
          <strong>{regressing}</strong>
        </div>
      </div>

      <h3>Criterion trend</h3>
      <p
        className="pc-rubric-detail__scope"
        data-testid="rubric-trend-sample-count"
        data-evidence={trendSampleLabel.evidence}
        aria-live="polite"
        aria-label={trendSampleLabel.ariaLabel}
      >
        {trendSampleLabel.summary}
      </p>
      {trend.loading ? (
        <div role="status">Loading trend…</div>
      ) : trend.error ? (
        <div role="status">Trend unavailable — {String(trend.error)}</div>
      ) : !trendRow || trendRow.criteria.length === 0 ? (
        <div role="status">No graded criteria yet.</div>
      ) : (
        <>
          {priorityCriteria.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <Table
                className="pc-rubric-trend"
                caption={`${priorityCriteria.length} changing criteria, regressions first`}
                columns={trendColumns}
                rows={priorityCriteria}
                getRowKey={(c) => c.criterion}
              />
            </div>
          ) : null}
          {stableCriteria.length > 0 ? (
            <Collapsible.Root open={stableOpen} onOpenChange={setStableOpen}>
              <Collapsible.Trigger className="pc-rubric-detail__disclosure">
                <ChevronDown size={13} aria-hidden />
                Stable criteria
                <strong>{stableCriteria.length}</strong>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div style={{ overflowX: "auto" }}>
                  <Table
                    className="pc-rubric-trend"
                    caption={`${stableCriteria.length} stable criteria`}
                    columns={trendColumns}
                    rows={stableCriteria}
                    getRowKey={(c) => c.criterion}
                  />
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
          ) : null}
        </>
      )}

      {scorecards.loading && rows.length === 0 ? (
        <div role="status">Loading scorecards…</div>
      ) : scorecards.error ? (
        <div role="status">
          Scorecards unavailable — {String(scorecards.error)}
        </div>
      ) : rows.length === 0 ? (
        <div role="status">No scorecards filed against this rubric yet.</div>
      ) : (
        <Collapsible.Root open={historyOpen} onOpenChange={setHistoryOpen}>
          <Collapsible.Trigger className="pc-rubric-detail__disclosure">
            <ChevronDown size={13} aria-hidden />
            Grading history
            <strong
              data-testid="rubric-history-count"
              data-evidence={loadedHistoryLabel.evidence}
              aria-live="polite"
              aria-label={loadedHistoryLabel.ariaLabel}
            >
              {loadedHistoryLabel.title}
            </strong>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div style={{ overflowX: "auto" }}>
              <Table
                className="pc-rubric-history"
                caption={`${loadedHistoryLabel.summary}, newest first — click a row for full ratings and evidence`}
                columns={historyColumns}
                rows={rows}
                getRowKey={(row) => row.issueId}
                onRowClick={(row) => setSelected(row)}
              />
            </div>
            {nextHistoryCursor ? (
              <button
                type="button"
                className="pc-rubric-detail__load-more"
                onClick={loadOlder}
                disabled={Boolean(scorecards.fetching)}
              >
                {scorecards.fetching
                  ? "Loading older scorecards…"
                  : "Load older scorecards"}
              </button>
            ) : null}
          </Collapsible.Content>
        </Collapsible.Root>
      )}
      <style>{`
        .pc-rubric-detail { display: flex; flex-direction: column; gap: 9px; min-height: 100%; padding: 10px; background: var(--bg-1); }
        .pc-rubric-detail__head { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
        .pc-rubric-detail__head > span { grid-column: 1; color: var(--fg-mute); font-size: 9.5px; font-weight: 750; text-transform: uppercase; letter-spacing: 0; }
        .pc-rubric-detail__head > strong { grid-column: 1; overflow: hidden; color: var(--fg); font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        .pc-rubric-detail__head button { grid-column: 2; grid-row: 1 / 4; display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--fg-mute); cursor: pointer; }
        .pc-rubric-detail__gov { grid-column: 1; display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin-top: 3px; }
        .pc-rubric-detail__gov-status { font-size: 9px; font-weight: 750; letter-spacing: 0; text-transform: uppercase; }
        .pc-rubric-detail__gov--active .pc-rubric-detail__gov-status { color: #34d399; }
        .pc-rubric-detail__gov--awaiting .pc-rubric-detail__gov-status { color: #f59e0b; }
        .pc-rubric-detail__gov--inactive .pc-rubric-detail__gov-status { color: var(--fg-mute); }
        .pc-rubric-detail__gov-chain { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 3px; color: var(--fg-mute); font-family: var(--font-mono, ui-monospace, monospace); font-size: 9px; }
        .pc-rubric-detail__gov-chain em { color: color-mix(in srgb, var(--fg-mute) 75%, transparent); font-style: normal; }
        .pc-rubric-detail__gov-split { display: inline-flex; align-items: center; margin-left: 3px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, #34d399 16%, transparent); color: #34d399; font-size: 8.5px; font-weight: 700; }
        .pc-rubric-trend__crit { display: inline-flex; align-items: baseline; gap: 6px; }
        .pc-rubric-trend__dir { display: inline-flex; align-items: center; justify-content: center; }
        .pc-rubric-trend__dir svg { display: block; }
        .pc-rubric-trend__instr { padding: 0 5px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 999px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); font-family: var(--font-mono, ui-monospace, monospace); font-size: 8.5px; font-style: normal; white-space: nowrap; }
        .pc-rubric-trend__instr[data-none] { border-color: var(--border); background: transparent; color: var(--fg-mute); }
        .pc-rubric-detail__overview { display: grid; grid-template-columns: 1.2fr repeat(3, minmax(64px, 1fr)); overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
        .pc-rubric-detail__overview > div { display: grid; grid-template-columns: auto auto; align-items: baseline; justify-content: start; gap: 5px; min-height: 38px; padding: 7px 9px; }
        .pc-rubric-detail__overview > div + div { border-left: 1px solid var(--border); }
        .pc-rubric-detail__overview span { color: var(--fg-mute); font-size: 8.5px; font-weight: 700; text-transform: uppercase; }
        .pc-rubric-detail__overview strong { color: var(--fg); font-size: 14px; font-variant-numeric: tabular-nums; }
        .pc-rubric-detail__overview .pc-rubric-detail__hero strong { color: var(--accent); font-size: 18px; letter-spacing: 0; }
        .pc-rubric-detail__overview small { color: var(--fg-mute); font-size: 9px; }
        .pc-rubric-detail__overview .is-good strong { color: #34d399; }
        .pc-rubric-detail__overview .is-bad strong { color: #fb7185; }
        .pc-rubric-detail > h3 { margin: 4px 0 -5px; color: var(--fg); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
        .pc-rubric-detail__scope { margin: 0; color: var(--fg-mute); font-size: 9.5px; line-height: 1.35; }
        .pc-rubric-detail__disclosure { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 31px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); color: var(--fg-mute); font: inherit; font-size: 10.5px; font-weight: 650; cursor: pointer; }
        .pc-rubric-detail__disclosure svg { transition: transform 140ms ease; }
        .pc-rubric-detail__disclosure[data-state="open"] svg { transform: rotate(180deg); }
        .pc-rubric-detail__disclosure strong { margin-left: auto; color: var(--fg); font-variant-numeric: tabular-nums; }
        .pc-rubric-detail__load-more { display: block; margin: 7px auto 0; padding: 5px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2); color: var(--fg-mute); font: inherit; font-size: 10px; cursor: pointer; }
        .pc-rubric-detail__load-more:disabled { cursor: progress; opacity: 0.65; }
        .pc-rubric-distribution { display: grid; grid-template-columns: minmax(72px, 1fr) auto; align-items: center; gap: 7px; min-width: 112px; }
        .pc-rubric-distribution__track { display: flex; height: 7px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--fg) 6%, transparent); }
        .pc-rubric-distribution__track i { display: block; min-width: 2px; height: 100%; background: var(--accent); }
        .pc-rubric-distribution__track i[data-tone="good"] { background: #34d399; }
        .pc-rubric-distribution__track i[data-tone="warn"] { background: #fbbf24; }
        .pc-rubric-distribution__track i[data-tone="bad"] { background: #fb7185; }
        .pc-rubric-distribution__track i[data-tone="neutral"] { background: #64748b; }
        .pc-rubric-distribution > strong { color: var(--fg-mute); font-size: 9.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
        @container learning (max-width: 720px) { .pc-rubric-detail__overview { grid-template-columns: repeat(2, 1fr); } .pc-rubric-detail__overview > div:nth-child(3) { border-left: 0; border-top: 1px solid var(--border); } .pc-rubric-detail__overview > div:nth-child(4) { border-top: 1px solid var(--border); } }
      `}</style>
    </div>
  );
}
