"use client";

/**
 * RubricsPanel — every rubric in the store with its grading rollup
 * (rubrics-tab-scorecard-ui-2026-07-09 P-001). Reads via `@papercusp/sync`
 * (rubrics.list) — the resolver reuses the SAME store reads rubrics:list /
 * scorecards:list serve agents, so this panel never diverges from what
 * graders see. Row click drills into grading history + scorecard detail
 * (P-002/P-003 — the scorecards.list / rubrics.trend queries are already
 * live server-side).
 */
import { useSyncQuery } from "@papercusp/sync";
import type { CSSProperties } from "react";
import { Table, type TableColumn } from "../harness/Table";

interface RubricRow {
  rubricId: string;
  characteristic: string;
  title: string;
  status: string;
  criteriaCount: number;
  ratingScale: string[];
  methodRef: string | null;
  updatedAt: string;
  scorecardCount: number;
  latestScorecardAt: string | null;
  latestScore10: number | null;
  avgScore10: number | null;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const min = ms / 60_000;
  if (min < 60) return `${Math.max(1, Math.round(min))}m ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (60 * 24))}d ago`;
}

export default function RubricsPanel({
  onSelect,
}: {
  onSelect?: (rubricId: string) => void;
}) {
  const { data, error, loading } = useSyncQuery<RubricRow>({
    queryName: "rubrics.list",
    args: {},
  });

  if (loading) {
    return (
      <div className="pc-rubrics" role="status">
        Loading rubrics…
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-rubrics pc-rubrics--error" role="status">
        Rubrics unavailable — {String(error)}
      </div>
    );
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div className="pc-rubrics" role="status">
        No rubrics in the store yet.
      </div>
    );
  }

  const graded = rows.filter((row) => row.avgScore10 != null);
  const avgScore =
    graded.length > 0
      ? graded.reduce((sum, row) => sum + (row.avgScore10 ?? 0), 0) /
        graded.length
      : null;
  const coverage = rows.length > 0 ? graded.length / rows.length : 0;
  const fresh = rows.filter((row) => {
    if (!row.latestScorecardAt) return false;
    const age = Date.now() - new Date(row.latestScorecardAt).getTime();
    return Number.isFinite(age) && age <= 30 * 24 * 60 * 60 * 1000;
  }).length;

  const columns: TableColumn<RubricRow>[] = [
    {
      key: "rubric",
      header: "Rubric",
      render: (row) => (
        <span className="pc-rubrics__identity">
          <i className={`is-${row.status}`} aria-hidden />
          <span>
            <strong>{row.title}</strong>
            <small>{row.rubricId}</small>
          </span>
        </span>
      ),
    },
    {
      key: "domain",
      header: "Domain",
      render: (row) => (
        <span className="pc-rubrics__domain">{row.characteristic}</span>
      ),
    },
    {
      key: "criteria",
      header: "Coverage",
      render: (row) => (
        <span
          className="pc-rubrics__criteria"
          title={`${row.criteriaCount} criteria`}
        >
          {Array.from(
            { length: Math.min(8, Math.max(1, row.criteriaCount)) },
            (_, index) => (
              <i key={index} />
            ),
          )}
          <small>{row.criteriaCount}</small>
        </span>
      ),
    },
    {
      key: "avgScore",
      header: "Score",
      render: (row) => (
        <span className="pc-rubrics__score">
          <i>
            <span
              style={{
                width: `${Math.max(0, Math.min(100, (row.avgScore10 ?? 0) * 10))}%`,
              }}
            />
          </i>
          <strong>{row.avgScore10?.toFixed(1) ?? "—"}</strong>
        </span>
      ),
      cellStyle: { fontVariantNumeric: "tabular-nums" },
      cellTitle: () =>
        "Read-time 0–10 projection (scale-aware: 3-level pass=10/partial=5/fail=0; extended exemplary=10/pass=8/partial=5/fail=2/severe=0; unknown excluded)",
    },
    {
      key: "scorecards",
      header: "Evidence",
      render: (row) => (
        <span className="pc-rubrics__evidence">{row.scorecardCount}</span>
      ),
    },
    {
      key: "lastGraded",
      header: "Freshness",
      render: (row) => (
        <span
          className={`pc-rubrics__freshness${row.latestScorecardAt ? "" : " is-stale"}`}
        >
          <i aria-hidden />
          {formatWhen(row.latestScorecardAt)}
        </span>
      ),
    },
  ];

  return (
    <section className="pc-rubrics" aria-label="Rubric coverage">
      <div className="pc-rubrics__overview">
        <div className="pc-rubrics__hero">
          <span>Average</span>
          <strong>{avgScore == null ? "—" : avgScore.toFixed(1)}</strong>
          <i>/10</i>
        </div>
        <div
          className="pc-rubrics__ring"
          style={
            { "--pc-rubric-coverage": `${coverage * 360}deg` } as CSSProperties
          }
        >
          <strong>{Math.round(coverage * 100)}%</strong>
          <span>covered</span>
        </div>
        <div
          className="pc-rubrics__pulse"
          aria-label={`${fresh} recently graded rubrics`}
        >
          {rows.map((row) => (
            <i
              key={row.rubricId}
              className={
                row.latestScorecardAt &&
                Date.now() - new Date(row.latestScorecardAt).getTime() <=
                  30 * 24 * 60 * 60 * 1000
                  ? "is-fresh"
                  : undefined
              }
              title={row.title}
            />
          ))}
        </div>
      </div>
      <Table
        caption={`${rows.length} rubric${rows.length === 1 ? "" : "s"}`}
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.rubricId}
        onRowClick={onSelect ? (row) => onSelect(row.rubricId) : undefined}
      />
      <style>{`
        .pc-rubrics { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
        .pc-rubrics__overview { display: grid; grid-template-columns: minmax(150px, .55fr) 116px minmax(220px, 1.8fr); gap: 10px; align-items: stretch; }
        .pc-rubrics__hero, .pc-rubrics__ring, .pc-rubrics__pulse { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2); }
        .pc-rubrics__hero { display: grid; grid-template-columns: auto 1fr auto; align-items: end; gap: 5px; padding: 13px 15px; }
        .pc-rubrics__hero span { grid-column: 1 / -1; color: var(--fg-mute); font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
        .pc-rubrics__hero strong { color: var(--accent); font-size: 32px; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.035em; }
        .pc-rubrics__hero i { color: var(--fg-mute); font-size: 11px; font-style: normal; }
        .pc-rubrics__ring { position: relative; display: grid; place-content: center; justify-items: center; margin: 0; }
        .pc-rubrics__ring::before { content: ''; position: absolute; inset: 11px; border-radius: 50%; background: conic-gradient(#34d399 var(--pc-rubric-coverage), color-mix(in srgb, var(--fg) 7%, transparent) 0); mask: radial-gradient(circle, transparent 52%, #000 54%); }
        .pc-rubrics__ring strong { color: var(--fg); font-size: 16px; font-variant-numeric: tabular-nums; }
        .pc-rubrics__ring span { color: var(--fg-mute); font-size: 9px; text-transform: uppercase; }
        .pc-rubrics__pulse { display: grid; grid-template-columns: repeat(auto-fit, minmax(8px, 1fr)); align-items: end; gap: 3px; padding: 12px; overflow: hidden; }
        .pc-rubrics__pulse i { min-height: 18px; height: 34%; border-radius: 2px; background: color-mix(in srgb, var(--fg) 9%, transparent); }
        .pc-rubrics__pulse i.is-fresh { height: 86%; background: color-mix(in srgb, var(--accent) 68%, #34d399); }
        .pc-rubrics__identity { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
        .pc-rubrics__identity > i { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--fg-mute); }
        .pc-rubrics__identity > i.is-ratified, .pc-rubrics__identity > i.is-active { background: #34d399; box-shadow: 0 0 0 3px color-mix(in srgb, #34d399 12%, transparent); }
        .pc-rubrics__identity span { min-width: 0; }
        .pc-rubrics__identity strong, .pc-rubrics__identity small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-rubrics__identity small { margin-top: 2px; color: var(--fg-mute); font-family: var(--font-mono, ui-monospace, monospace); font-size: 9px; }
        .pc-rubrics__domain { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; color: var(--fg-mute); font-size: 10px; }
        .pc-rubrics__criteria { display: inline-flex; align-items: center; gap: 2px; }
        .pc-rubrics__criteria i { width: 4px; height: 13px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 62%, transparent); }
        .pc-rubrics__criteria small { margin-left: 4px; color: var(--fg-mute); font-size: 9px; }
        .pc-rubrics__score { display: grid; grid-template-columns: minmax(52px, 1fr) 26px; align-items: center; gap: 7px; }
        .pc-rubrics__score > i { height: 6px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--fg) 7%, transparent); }
        .pc-rubrics__score > i span { display: block; height: 100%; border-radius: inherit; background: #34d399; }
        .pc-rubrics__score strong { color: var(--fg); font-size: 10px; text-align: right; }
        .pc-rubrics__evidence { display: inline-grid; place-items: center; min-width: 28px; height: 22px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 9%, transparent); color: var(--accent); font-size: 10px; font-weight: 700; }
        .pc-rubrics__freshness { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-mute); font-size: 10px; }
        .pc-rubrics__freshness i { width: 6px; height: 6px; border-radius: 50%; background: #34d399; }
        .pc-rubrics__freshness.is-stale i { background: #fbbf24; }
        @media (max-width: 760px) { .pc-rubrics__overview { grid-template-columns: 1fr 100px; } .pc-rubrics__pulse { grid-column: 1 / -1; min-height: 54px; } }
      `}</style>
    </section>
  );
}
