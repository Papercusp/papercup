"use client";

/**
 * create:observations — the Observations browse pane (turn-end-reflection-
 * observations-2026-06-14 P-043 / D-005).
 *
 * PRE-IDEA sensor readings agents record at the END of a turn (the reflection
 * step), filed in the SEPARATE observation lane. This pane is BROWSE-ONLY:
 * observations never enter the work/triage queue (that is the whole point), so
 * there is deliberately NO triage / dispatch / claim affordance here. Data is
 * the `learning.observations` sync resolver (newest first); the only path from
 * an observation to actual work is Scout clustering a RECURRING one and
 * promoting it to a real idea — never from this surface.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useSyncQuery } from "@papercusp/sync";
import { VirtualGrid, type ColumnDef } from "@papercusp/grid-core";
import { readListTotal } from "@papercusp/operator-core/lib/sync-resolver/list-meta";
import type { PanelComponentProps } from "@/app/harness/dock/panel-registry";
import { useItemPlanFilter } from "./use-create-data";
import { OBSERVATION_KIND_COLOR } from "@/app/harness/theme";
import { Tooltip } from "@/app/harness/Tooltip";

interface ObservationRow {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[];
  sourceRole: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  friction: "Friction",
  workaround: "Workaround",
  gap: "Gap",
  surprise: "Surprise",
  reinforce: "Reinforce",
};

// Same growing server window used by Working → Work Queue. VirtualGrid keeps DOM
// work bounded while the explicit limit makes each next page part of the same
// sync-query stream. The resolver carries the true count on row[0]._meta.
export const OBSERVATIONS_PAGE = 200;

export default function ObservationsPanel({
  onStatus,
}: Partial<PanelComponentProps> & {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
} = {}) {
  const [itemPlans] = useItemPlanFilter();
  const [limit, setLimit] = useState(OBSERVATIONS_PAGE);
  const [signalFilter, setSignalFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemPlanKey = itemPlans.join("\u0000");
  useEffect(() => setLimit(OBSERVATIONS_PAGE), [itemPlanKey]);

  const query = useSyncQuery<ObservationRow>({
    queryName: "learning.observations",
    args: { limit },
    staleTime: 30_000,
  });
  // Keep cached rows painted while a larger window or push invalidation refetches.
  const allRows = query.data ?? [];
  const scopedRows = useMemo(
    () =>
      itemPlans.length
        ? allRows.filter((row) => observationMatchesPlan(row, itemPlans))
        : allRows,
    [allRows, itemPlans],
  );
  const rows = useMemo(
    () =>
      signalFilter
        ? scopedRows.filter((row) => (row.kind ?? "other") === signalFilter)
        : scopedRows,
    [scopedRows, signalFilter],
  );
  const total = readListTotal(query.data);
  const hasMore = allRows.length < total;
  const signalCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of scopedRows) {
      const kind = row.kind ?? "other";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      if (a[0] === "other") return 1;
      if (b[0] === "other") return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
  }, [scopedRows]);
  useEffect(() => {
    if (signalFilter && !signalCounts.some(([kind]) => kind === signalFilter)) {
      setSignalFilter(null);
    }
  }, [signalCounts, signalFilter]);
  useEffect(() => {
    if (selectedId && !rows.some((row) => row.id === selectedId)) {
      setSelectedId(null);
    }
  }, [rows, selectedId]);
  useEffect(() => {
    onStatus?.(
      query.error ? "bad" : scopedRows.length > 0 ? "good" : "neutral",
    );
  }, [onStatus, query.error, scopedRows.length]);
  const loadMore = useCallback(
    () => setLimit((current) => current + OBSERVATIONS_PAGE),
    [],
  );

  const columns = useMemo<ColumnDef<ObservationRow>[]>(
    () => [
      {
        key: "observation",
        header: "Observation",
        width: 8,
        toCopyText: (row) =>
          [
            row.kind ? (KIND_LABEL[row.kind] ?? row.kind) : null,
            row.title,
            row.body,
            [row.sourceRole, row.scope, row.confidence, ...row.refs]
              .filter(Boolean)
              .join(" · "),
          ]
            .filter(Boolean)
            .join("\n"),
        render: ({ row }) => {
          const selected = selectedId === row.id;
          const context = [
            row.sourceRole,
            row.scope,
            row.confidence,
            ...row.refs,
          ]
            .filter(Boolean)
            .join(" · ");
          const signal = row.kind
            ? (KIND_LABEL[row.kind] ?? row.kind)
            : "Other";
          return (
            <Tooltip label={row.body ?? row.title}>
              <button
                type="button"
                className={`pc-observations__entry${selected ? " is-selected" : ""}`}
                aria-label={`${selected ? "Collapse" : "Expand"} observation ${row.title}`}
                aria-expanded={selected}
                onClick={() => setSelectedId(selected ? null : row.id)}
              >
              <span
                className="pc-observations__signalmark"
                aria-label={`${signal} signal`}
                title={signal}
              >
                <i
                  aria-hidden
                  style={{
                    background:
                      OBSERVATION_KIND_COLOR[row.kind ?? ""] ??
                      "var(--fg-mute)",
                  }}
                />
                <span className="pc-observations__sr-only">{signal}</span>
              </span>
              <span className="pc-observations__copy">
                <strong>{row.title}</strong>
                {row.body ? <span>{row.body}</span> : null}
                {selected && context ? (
                  <em className="pc-observations__context">{context}</em>
                ) : null}
              </span>
              </button>
            </Tooltip>
          );
        },
      },
      {
        key: "createdAt",
        header: "Observed",
        width: 2,
        toCopyText: (row) => row.createdAt,
        render: ({ row }) => (
          <span
            className="pc-observations__time"
            title={new Date(row.createdAt).toLocaleString()}
          >
            {new Date(row.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        ),
      },
    ],
    [selectedId],
  );

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="pc-observations__toolbar">
        {signalCounts.length > 0 ? (
          <div
            className="pc-observations__distribution"
            aria-label="Loaded signal distribution"
          >
            {signalCounts.map(([kind, count]) => (
              <Tooltip
                key={kind}
                label={`${KIND_LABEL[kind] ?? kind}: ${count}`}
              >
                <button
                  type="button"
                  aria-label={`Filter by ${KIND_LABEL[kind] ?? kind}, ${count}`}
                  aria-pressed={signalFilter === kind}
                  onClick={() =>
                    setSignalFilter((current) =>
                      current === kind ? null : kind,
                    )
                  }
                  className={kind === "other" ? "is-other" : undefined}
                >
                  <i
                    aria-hidden
                    style={{
                      background:
                        OBSERVATION_KIND_COLOR[kind] ?? "var(--fg-mute)",
                    }}
                  />
                  <span>{KIND_LABEL[kind] ?? kind}</span>
                  <strong>{count}</strong>
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
        {total > 0 ? (
          <span
            data-testid="observations-count"
            aria-label={`${allRows.length} observations loaded of ${total} total`}
            title="Loaded observations / total available"
            style={{
              color: "var(--fg-mute)",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {allRows.length.toLocaleString()} / {total.toLocaleString()}
          </span>
        ) : null}
        <button
          type="button"
          className="pc-advpanel__iconbtn"
          aria-label="Refresh observations"
          disabled={query.fetching}
          onClick={() => query.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      {query.loading && rows.length === 0 ? (
        <div style={{ color: "var(--fg-mute)", padding: 12 }}>
          Loading observations…
        </div>
      ) : query.error ? (
        <div style={{ color: "var(--bad)", padding: 12 }}>
          Could not load observations.
        </div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--fg-mute)", padding: 12 }}>
          {itemPlans.length || signalFilter
            ? "No observations match the selected filters."
            : "No observations yet — they appear as agents reflect at the end of their turns."}
        </div>
      ) : (
        <VirtualGrid<ObservationRow>
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          rowMinHeight={44}
          headerHeight={30}
          onEndReached={hasMore ? loadMore : undefined}
        />
      )}
      <style>{`
        .pc-observations__toolbar { min-height: 30px; display: flex; align-items: center; justify-content: flex-end; gap: 9px; }
        .pc-observations__distribution { display: flex; flex: 1 1 auto; align-items: center; gap: 5px; min-width: 0; overflow-x: auto; }
        .pc-observations__distribution button { display: inline-flex; flex: none; align-items: center; gap: 5px; min-height: 25px; padding: 3px 7px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--fg-mute); font: inherit; font-size: 9.5px; cursor: pointer; transition: color 140ms ease, border-color 140ms ease, background 140ms ease; }
        .pc-observations__distribution button:hover, .pc-observations__distribution button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); background: color-mix(in srgb, var(--accent) 7%, var(--bg-2)); color: var(--fg); }
        .pc-observations__distribution button.is-other { margin-left: 4px; border-style: dashed; opacity: .82; }
        .pc-observations__distribution button > i { width: 6px; height: 6px; flex: none; border-radius: 50%; }
        .pc-observations__distribution button > strong { color: var(--fg); font-size: 9.5px; font-variant-numeric: tabular-nums; }
        .pc-observations__entry { width: 100%; min-width: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr); align-items: start; gap: 7px; padding: 1px 0; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
        .pc-observations__entry:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
        .pc-observations__entry.is-selected .pc-observations__copy > strong { color: var(--accent); }
        .pc-observations__signalmark { display: grid; place-items: center; width: 10px; height: 20px; }
        .pc-observations__signalmark i { width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 6%, transparent); }
        .pc-observations__copy { display: grid; gap: 2px; min-width: 0; }
        .pc-observations__copy > strong, .pc-observations__copy > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-observations__copy > strong { font-size: 12px; font-weight: 620; }
        .pc-observations__copy > span, .pc-observations__context { color: var(--fg-mute); font-size: 10.5px; }
        .pc-observations__context { overflow-wrap: anywhere; font-style: normal; white-space: normal; }
        .pc-observations__time { display: block; overflow: hidden; color: var(--fg-mute); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
        .pc-observations__sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      `}</style>
    </div>
  );
}

function observationMatchesPlan(
  row: ObservationRow,
  planSlugs: readonly string[],
): boolean {
  if (planSlugs.length === 0) return true;
  const refs = row.refs.map((r) => r.toLowerCase());
  return planSlugs.some((slug) => {
    const s = slug.toLowerCase();
    const token = new RegExp(
      `(^|[^a-z0-9_-])${escapeRegExp(s)}($|[^a-z0-9_-])`,
    );
    return refs.some(
      (ref) => ref === s || ref === `plan:${s}` || token.test(ref),
    );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
