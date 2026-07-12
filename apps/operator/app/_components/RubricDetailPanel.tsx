"use client";

/**
 * RubricDetailPanel — a single rubric's grading history + per-criterion trend
 * (rubrics-tab-scorecard-ui-2026-07-09 P-002). Reads the already-live
 * `scorecards.list` + `rubrics.trend` sync queries (the SAME store reads
 * scorecards:list / rubrics:trend serve agents). Clicking a scorecard row
 * opens the full ScorecardDetail (P-003) — no extra fetch, the list rows
 * already carry the complete ratings map.
 */
import { useState } from "react";
import { useSyncQuery } from "@papercusp/sync";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, X } from "lucide-react";
import { Table, type TableColumn } from "../harness/Table";
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
}

interface RubricTrend {
  rubricRef: string;
  scorecardCount: number;
  window: { since?: string; from?: string; to?: string };
  criteria: CriterionTrend[];
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

  const scorecards = useSyncQuery<ScorecardRow>({
    queryName: "scorecards.list",
    args: { rubricRef: rubricId },
  });
  const trend = useSyncQuery<RubricTrend>({
    queryName: "rubrics.trend",
    args: { rubricRef: rubricId },
  });

  if (selected) {
    return (
      <ScorecardDetail scorecard={selected} onBack={() => setSelected(null)} />
    );
  }

  const rows = scorecards.data ?? [];
  const trendRow = trend.data?.[0];
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
          render: (c) => c.criterion,
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
          render: (c) => `${directionGlyph(c.direction)} ${c.direction}`,
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

      <div className="pc-rubric-detail__overview">
        <div className="pc-rubric-detail__hero">
          <span>Mean</span>
          <strong>{mean == null ? "—" : mean.toFixed(1)}</strong>
          <small>/10</small>
        </div>
        <div>
          <span>Scorecards</span>
          <strong>{trendRow?.scorecardCount ?? rows.length}</strong>
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

      {scorecards.loading ? (
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
            <strong>{rows.length}</strong>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div style={{ overflowX: "auto" }}>
              <Table
                className="pc-rubric-history"
                caption={`${rows.length} scorecard${rows.length === 1 ? "" : "s"}, newest first — click a row for full ratings and evidence`}
                columns={historyColumns}
                rows={rows}
                getRowKey={(row) => row.issueId}
                onRowClick={(row) => setSelected(row)}
              />
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
      <style>{`
        .pc-rubric-detail { display: flex; flex-direction: column; gap: 9px; min-height: 100%; padding: 10px; background: var(--bg-1); }
        .pc-rubric-detail__head { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
        .pc-rubric-detail__head > span { grid-column: 1; color: var(--fg-mute); font-size: 9.5px; font-weight: 750; text-transform: uppercase; letter-spacing: 0; }
        .pc-rubric-detail__head > strong { grid-column: 1; overflow: hidden; color: var(--fg); font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        .pc-rubric-detail__head button { grid-column: 2; grid-row: 1 / 3; display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--fg-mute); cursor: pointer; }
        .pc-rubric-detail__overview { display: grid; grid-template-columns: 1.4fr repeat(3, minmax(70px, 1fr)); gap: 7px; }
        .pc-rubric-detail__overview > div { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-height: 54px; padding: 7px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
        .pc-rubric-detail__overview span { color: var(--fg-mute); font-size: 8.5px; font-weight: 700; text-transform: uppercase; }
        .pc-rubric-detail__overview strong { color: var(--fg); font-size: 16px; font-variant-numeric: tabular-nums; }
        .pc-rubric-detail__overview .pc-rubric-detail__hero strong { color: var(--accent); font-size: 23px; letter-spacing: 0; }
        .pc-rubric-detail__overview small { color: var(--fg-mute); font-size: 9px; }
        .pc-rubric-detail__overview .is-good strong { color: #34d399; }
        .pc-rubric-detail__overview .is-bad strong { color: #fb7185; }
        .pc-rubric-detail > h3 { margin: 4px 0 -5px; color: var(--fg); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
        .pc-rubric-detail__disclosure { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 31px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); color: var(--fg-mute); font: inherit; font-size: 10.5px; font-weight: 650; cursor: pointer; }
        .pc-rubric-detail__disclosure svg { transition: transform 140ms ease; }
        .pc-rubric-detail__disclosure[data-state="open"] svg { transform: rotate(180deg); }
        .pc-rubric-detail__disclosure strong { margin-left: auto; color: var(--fg); font-variant-numeric: tabular-nums; }
        .pc-rubric-distribution { display: grid; grid-template-columns: minmax(72px, 1fr) auto; align-items: center; gap: 7px; min-width: 112px; }
        .pc-rubric-distribution__track { display: flex; height: 7px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--fg) 6%, transparent); }
        .pc-rubric-distribution__track i { display: block; min-width: 2px; height: 100%; background: var(--accent); }
        .pc-rubric-distribution__track i[data-tone="good"] { background: #34d399; }
        .pc-rubric-distribution__track i[data-tone="warn"] { background: #fbbf24; }
        .pc-rubric-distribution__track i[data-tone="bad"] { background: #fb7185; }
        .pc-rubric-distribution__track i[data-tone="neutral"] { background: #64748b; }
        .pc-rubric-distribution > strong { color: var(--fg-mute); font-size: 9.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
        @media (max-width: 720px) { .pc-rubric-detail__overview { grid-template-columns: repeat(2, 1fr); } }
      `}</style>
    </div>
  );
}
