"use client";

import { useMemo, type CSSProperties } from "react";
import { parseAsStringEnum, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import type {
  AdmissionRunKind,
  AdmissionRunOutcomeTotals,
  AdmissionRunState,
  WorkItemAdmissionRun,
  WorkItemAdmissionSnapshot,
} from "@papercusp/operator-core/lib/work-items-admission-promoter";
import { Select } from "@/app/harness/Select";
import { Table, type TableColumn } from "@/app/harness/Table";

type KindFilter = "all" | AdmissionRunKind;
type StateFilter = "all" | AdmissionRunState;

const KINDS: readonly KindFilter[] = [
  "all",
  "census",
  "promoter-tick",
  "bulk-stage",
  "delta-sweep",
  "daily-digest",
  "durable-park-audit",
];
const STATES: readonly StateFilter[] = [
  "all",
  "running",
  "complete",
  "blocked",
  "failed",
];

const PAGE_STYLE: CSSProperties = {
  display: "grid",
  gap: 14,
  padding: "18px clamp(14px, 3vw, 30px) 28px",
  color: "var(--fg, #e7f7ff)",
};
const PANEL_STYLE: CSSProperties = {
  border: "1px solid var(--border, rgba(125, 211, 252, 0.18))",
  borderRadius: 10,
  background: "var(--bg-1, #0b1220)",
  padding: 14,
};
const MUTED_STYLE: CSSProperties = { color: "var(--fg-mute, #7f9bb4)" };

function numberOrDash(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

function duration(value: number | null): string {
  if (value == null) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000)
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = value / 60_000;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function when(value: string | null): string {
  if (!value) return "—";
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : instant.toLocaleString();
}

function stateColor(state: string): string {
  if (state === "complete") return "var(--good, #34d399)";
  if (state === "failed") return "var(--bad, #fb7185)";
  if (state === "running") return "var(--accent, #67e8f9)";
  return "var(--warn, #fbbf24)";
}

function outcomeUnitLabel(unit: WorkItemAdmissionRun["outcome"]["unit"]): string {
  if (unit === "items") return "run-local unique items";
  if (unit === "pairs") return "pair verdicts";
  if (unit === "links") return "link coverage";
  if (unit === "parks") return "run-local unique parks";
  if (unit === "snapshots") return "repeated snapshots";
  return "unit unknown";
}

/** Dependency-free, token-themed trend used by the validated P-005 UI IR. */
function CensusSparkline({ values }: { values: number[] }) {
  if (values.length < 2)
    return <span style={MUTED_STYLE}>Not enough census samples yet.</span>;
  const width = 420;
  const height = 64;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map(
      (value, index) =>
        `${(index * step).toFixed(1)},${(height - ((value - min) / span) * height).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={`Unadjudicated census trend: ${values.join(", ")}`}
      preserveAspectRatio="none"
      style={{ display: "block", maxWidth: width }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent, #67e8f9)"
        strokeWidth={2}
      />
    </svg>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div style={{ ...PANEL_STYLE, minWidth: 0 }}>
      <div style={{ ...MUTED_STYLE, fontSize: 11, marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 730, lineHeight: 1.1 }}>
        {value}
      </div>
      {detail ? (
        <div style={{ ...MUTED_STYLE, fontSize: 11, marginTop: 6 }}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

const RUN_COLUMNS: TableColumn<WorkItemAdmissionRun>[] = [
  {
    key: "state",
    header: "State",
    render: (row) => (
      <span style={{ color: stateColor(row.state), fontWeight: 650 }}>
        {row.state}{" "}
        <small style={MUTED_STYLE}>
          ({row.stateSource === "writer" ? "writer" : row.stateSource ?? "legacy"})
        </small>
      </span>
    ),
  },
  { key: "kind", header: "Kind", render: (row) => <code>{row.runKind}</code> },
  { key: "harness", header: "Harness", render: (row) => row.harnessSlug },
  {
    key: "disposition",
    header: "Run-local promoted / merged / held",
    render: (row) =>
      `${numberOrDash(row.promoted)} / ${numberOrDash(row.merged)} / ${numberOrDash(row.held)}`,
  },
  {
    key: "outcome",
    header: "Attempted / successful / unchanged / rolled back · rows changed",
    render: (row) => (
      <span
        title={`Counter unit: ${outcomeUnitLabel(row.outcome.unit)}; source: ${row.outcomeSource ?? "legacy-derived"}`}
      >
        {numberOrDash(row.outcome.attempted)} / {numberOrDash(row.outcome.successful)} /{" "}
        {numberOrDash(row.outcome.unchanged)} / {numberOrDash(row.outcome.rolledBack)}{" "}
        · {numberOrDash(row.outcome.uniqueRowsChanged)}{" "}
        <small style={MUTED_STYLE}>
          ({outcomeUnitLabel(row.outcome.unit)} · {row.outcomeSource ?? "legacy-derived"})
        </small>
      </span>
    ),
  },
  {
    key: "census",
    header: "Census before → after",
    render: (row) => {
      if (row.censusBefore == null || row.censusAfter == null) return "—";
      const delta = row.censusDelta ?? 0;
      return (
        <span style={{ color: delta > 0 ? "var(--bad, #fb7185)" : undefined }}>
          {row.censusBefore.toLocaleString()} →{" "}
          {row.censusAfter.toLocaleString()} ({delta > 0 ? "+" : ""}
          {delta})
        </span>
      );
    },
  },
  {
    key: "unreviewed",
    header: "Fail-open",
    render: (row) => numberOrDash(row.autoPromotedUnreviewed),
  },
  {
    key: "model",
    header: "Model / tokens",
    render: (row) => (
      <span title={row.modelId ?? undefined}>
        {row.modelId ?? "deterministic"} ·{" "}
        {numberOrDash((row.tokensIn ?? 0) + (row.tokensOut ?? 0))}
      </span>
    ),
  },
  {
    key: "latency",
    header: "Run latency",
    render: (row) => duration(row.latencyMs),
  },
  {
    key: "reason",
    header: "Failure / blocked reason",
    render: (row) => row.outcome.failureReason ?? row.outcome.blockedReason ?? "—",
  },
  { key: "started", header: "Started", render: (row) => when(row.startedAt) },
];

export default function AdmissionRunsClient() {
  const [kind, setKind] = useQueryState(
    "kind",
    parseAsStringEnum<KindFilter>([...KINDS]).withDefault("all"),
  );
  const [state, setState] = useQueryState(
    "state",
    parseAsStringEnum<StateFilter>([...STATES]).withDefault("all"),
  );
  const args = useMemo(
    () => ({
      ...(kind === "all" ? {} : { kind }),
      ...(state === "all" ? {} : { state }),
      limit: 100,
    }),
    [kind, state],
  );
  const query = useSyncQuery<WorkItemAdmissionSnapshot>({
    queryName: "workItemAdmission.runs",
    args,
    staleTime: 30_000,
  });
  const payload = query.data?.[0];
  const summary = payload?.summary;
  const runs = payload?.runs ?? [];
  const trendValues = useMemo(
    () => payload?.censusTrend.map((point) => point.after) ?? [],
    [payload],
  );
  const outcomeUnitSummary = useMemo(() => {
    const entries = (Object.entries(summary?.runCounts.byUnit ?? {}) as Array<
      [string, AdmissionRunOutcomeTotals]
    >).filter(([, counts]) => counts.runs > 0);
    return {
      count: entries.length,
      detail: entries
        .map(([unit, counts]) =>
          `${unit}: ${counts.successful.toLocaleString()}/${counts.attempted.toLocaleString()} · ${counts.uniqueRowsChanged.toLocaleString()} unique row change(s) · ${counts.unchanged.toLocaleString()} unchanged · ${counts.rolledBack.toLocaleString()} rolled back`,
        )
        .join(" · "),
    };
  }, [summary]);

  if (query.loading && !payload) {
    return <div style={PAGE_STYLE}>Loading admission runs…</div>;
  }

  if (query.error && !payload) {
    return (
      <div style={PAGE_STYLE}>
        <div
          role="alert"
          style={{ ...PANEL_STYLE, borderColor: "var(--bad, #fb7185)" }}
        >
          <strong>Admission data unavailable.</strong>{" "}
          <span style={MUTED_STYLE}>{query.error.message}</span>
        </div>
      </div>
    );
  }

  return (
    <section style={PAGE_STYLE} aria-label="Work-item admission runs">
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>Queue admission health</h2>
        <p style={{ ...MUTED_STYLE, margin: "5px 0 0", fontSize: 12 }}>
          Durable promoter, fail-open, census, and bulk-stage evidence for the
          active workspace.
        </p>
      </div>

      {summary?.latestCensusRise ? (
        <div
          role="alert"
          data-testid="census-rise-alarm"
          style={{
            ...PANEL_STYLE,
            borderColor: "var(--bad, #fb7185)",
            background:
              "color-mix(in srgb, var(--bad, #fb7185), transparent 92%)",
          }}
        >
          <strong>
            Unadjudicated census rose by {summary.latestCensusRise.delta}.
          </strong>{" "}
          <span style={MUTED_STYLE}>
            {summary.latestCensusRise.before} → {summary.latestCensusRise.after}{" "}
            in {summary.latestCensusRise.runId} ·{" "}
            {when(summary.latestCensusRise.startedAt)}
          </span>
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        <Stat
          label="Pending admission"
          value={(summary?.pending ?? 0).toLocaleString()}
        />
        <Stat
          label="Admitted unreviewed"
          value={(summary?.unreviewed ?? 0).toLocaleString()}
        />
        <Stat
          label="Promoted → first claim · p50"
          value={duration(summary?.promotedToFirstClaim.p50Ms ?? null)}
          detail={`${summary?.promotedToFirstClaim.sampleSize ?? 0} claimed item(s)`}
        />
        <Stat
          label="Promoted → first claim · p95"
          value={duration(summary?.promotedToFirstClaim.p95Ms ?? null)}
        />
        <Stat
          label="Latest unadjudicated census"
          value={(summary?.latestCensus?.after ?? 0).toLocaleString()}
          detail={
            summary?.latestCensus
              ? `${summary.latestCensus.harnessSlug} · ${when(summary.latestCensus.startedAt)}`
              : "No census yet"
          }
        />
        <Stat
          label="Run states (shown)"
          value={`${summary?.runCounts.complete ?? 0}/${summary?.runCounts.total ?? 0}`}
          detail={`${summary?.runCounts.failed ?? 0} failed · ${summary?.runCounts.blocked ?? 0} blocked · ${summary?.runCounts.running ?? 0} running`}
        />
        <Stat
          label="Outcome counters by unit (shown)"
          value={`${outcomeUnitSummary.count} unit${outcomeUnitSummary.count === 1 ? "" : "s"}`}
          detail={outcomeUnitSummary.detail || "No outcome counters yet"}
        />
      </div>

      <div style={PANEL_STYLE}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong style={{ fontSize: 13 }}>Unadjudicated pair census</strong>
            <div style={{ ...MUTED_STYLE, fontSize: 11, marginTop: 3 }}>
              Chronological after-run samples; the expected direction is flat or
              down.
            </div>
          </div>
          <span style={{ ...MUTED_STYLE, fontSize: 11 }}>
            {trendValues.length} sample(s)
          </span>
        </div>
        <CensusSparkline values={trendValues} />
      </div>

      <div style={{ ...PANEL_STYLE, padding: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <strong style={{ marginRight: "auto" }}>Admission runs</strong>
          <label
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              fontSize: 11,
            }}
          >
            <span style={MUTED_STYLE}>Kind</span>
            <Select
              value={kind}
              onChange={(value) => void setKind(value as KindFilter)}
              ariaLabel="Filter admission runs by kind"
              options={KINDS.map((value) => ({
                value,
                label: value === "all" ? "All kinds" : value,
              }))}
            />
          </label>
          <label
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              fontSize: 11,
            }}
          >
            <span style={MUTED_STYLE}>State</span>
            <Select
              value={state}
              onChange={(value) => void setState(value as StateFilter)}
              ariaLabel="Filter admission runs by state"
              options={STATES.map((value) => ({
                value,
                label: value === "all" ? "All states" : value,
              }))}
            />
          </label>
        </div>
        <div style={{ overflowX: "auto" }}>
          <Table
            caption={`${runs.length} admission run${runs.length === 1 ? "" : "s"}`}
            columns={RUN_COLUMNS}
            rows={runs}
            getRowKey={(row) => row.id}
            emptyLabel="No admission runs match these filters."
          />
        </div>
      </div>
    </section>
  );
}
