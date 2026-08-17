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
 *
 * WI-4374: Real COUNT query (learning.observations.counts) replaces the
 * loaded-list-length fallback, with "500+" render guard when count >= 500,
 * and staleness tone based on newest-age (createdAt of the newest observation).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Table2, Layers, Search } from "lucide-react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import {
  VirtualGrid,
  type ColumnDef,
  type FilterableColumn,
} from "@papercusp/grid-core";
import { readListTotal } from "@papercusp/operator-core/lib/sync-resolver/list-meta";
import type { PanelComponentProps } from "@/app/harness/dock/panel-registry";
import {
  useColumnFilters,
  ColumnFilterBar,
  filterCountLabel,
} from "@/app/harness/filters";
import { CardStack } from "@papercusp/card-stack";
import { useItemPlanFilter } from "./use-create-data";
import { OBSERVATION_KIND_COLOR } from "@/app/harness/theme";
import { Tooltip } from "@/app/harness/Tooltip";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";

// Mirrors LearningObservationRow (sync-resolver/learning-observations-read.ts).
// The optional fields are OMITTED from the wire when null (D-025, WI-7303) — every
// read site below already goes through `??`/truthiness, so absent and null behave
// identically here.
interface ObservationRow {
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

interface CountRow {
  kind: string;
  count: number;
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

// Module-level EMPTY sentinel, not a `?? []` fresh literal at the use site.
// `allRows` feeds a useMemo dependency array (and, through it, useColumnFilters),
// so a new [] on every render makes every downstream memo miss its cache for as
// long as the query has no data — the same defect WorkItemsPanel's NO_ROWS
// comment names (WI-37386 / WI-39552). One frozen instance keeps the identity
// stable across renders.
const NO_ROWS: ObservationRow[] = [];

/**
 * Render count with "500+" guard: when count >= 500, display "500+"
 * instead of the exact number (WI-4374).
 */
function formatCount(count: number): string {
  return count >= 500 ? "500+" : count.toLocaleString();
}

/**
 * Split an expanded observation's BODY into a bold headline + preview at a
 * sentence-ish boundary (the Retain view's learningPreview pattern). Agents
 * file title = a hard character truncation of the body (often behind a
 * "[kind] " tag), so rendering title + body repeats the text and the stored
 * title can cut mid-word — the body is the readable source of truth.
 */
function splitBodyHeadline(text: string): { headline: string; rest: string } {
  const normalized = text.replace(/\s+/g, " ").trim();
  const boundary = [/\.\s/, /:\s/, / —\s/, /;\s/]
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 32 && index <= 140)
    .sort((a, b) => a - b)[0];
  const cut =
    boundary ??
    (normalized.length > 120
      ? normalized.lastIndexOf(" ", 120)
      : normalized.length);
  const safeCut =
    cut > 0 ? cut + (boundary == null ? 0 : 1) : normalized.length;
  return {
    headline: normalized.slice(0, safeCut).trim(),
    rest: normalized.slice(safeCut).trim(),
  };
}

/** Does the body's text subsume the stored title (title = body-head truncation)? */
function bodySubsumesTitle(title: string, body: string): boolean {
  const head = title
    .replace(/^\[[^\]]{1,32}\]\s*/, "")
    .replace(/[…\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return head.length > 0 && body.replace(/\s+/g, " ").trim().startsWith(head);
}

/**
 * Compute staleness tone based on the newest observation's age.
 * Returns "fresh" | "stale" | "very-stale" for visual indication.
 */
function getStalenessFromNewest(
  newestCreatedAt: string | null | undefined,
): "fresh" | "stale" | "very-stale" {
  if (!newestCreatedAt) return "very-stale";
  const newestMs = new Date(newestCreatedAt).getTime();
  const nowMs = Date.now();
  const ageMs = nowMs - newestMs;
  const ageMinutes = ageMs / (1000 * 60);
  // fresh: <30min, stale: 30min-2h, very-stale: >2h
  if (ageMinutes < 30) return "fresh";
  if (ageMinutes < 120) return "stale";
  return "very-stale";
}

export default function ObservationsPanel({
  onStatus,
  active = true,
}: Partial<PanelComponentProps> & {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED learning view. LearningTab keeps warm
   *  panes mounted and only flips `hidden`, so the settle point needs this to
   *  fire on a revisit that does not remount (EI-19383745196363732). */
  active?: boolean;
} = {}) {
  const [itemPlans] = useItemPlanFilter();
  const [limit, setLimit] = useState(OBSERVATIONS_PAGE);
  const [signalFilter, setSignalFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // #4: shared filter/search libs, mirroring the Working → Work Queue pane.
  // A global quick-search (`obsq`) sits beside the shared ColumnFilterBar
  // (scope / role / confidence enums, `obsf` param via useColumnFilters).
  const [search, setSearch] = useQueryState(
    "obsq",
    parseAsString.withDefault(""),
  );
  // #7: Table (the rich grid) vs Stacks (same-kind cards overlapping, browsed
  // one at a time). Owner ask 2026-07-19.
  const [obsView, setObsView] = useQueryState(
    "obsview",
    parseAsStringEnum(["table", "stacks"]).withDefault("table"),
  );
  const itemPlanKey = itemPlans.join("\0");
  useEffect(() => setLimit(OBSERVATIONS_PAGE), [itemPlanKey]);

  const query = useSyncQuery<ObservationRow>({
    queryName: "learning.observations",
    args: { limit },
    staleTime: 30_000,
  });

  // Fetch the real counts from the database
  const countsQuery = useSyncQuery<CountRow>({
    queryName: "learning.observations.counts",
    args: {},
    staleTime: 30_000,
  });

  // Keep cached rows painted while a larger window or push invalidation refetches.
  const allRows = query.data ?? NO_ROWS;
  const scopedRows = useMemo(
    () =>
      itemPlans.length
        ? allRows.filter((row) => observationMatchesPlan(row, itemPlans))
        : allRows,
    [allRows, itemPlans],
  );
  // Shared column filters (scope / role / confidence) over the plan-scoped rows
  // — the same engine + bar the Work Queue uses (#4). Kind stays on the count
  // chips below (they carry authoritative DB counts the enum bar can't).
  const filterColumns = useMemo<FilterableColumn<ObservationRow>[]>(
    () => [
      {
        key: "scope",
        header: "Scope",
        filter: { type: "enum", accessor: (row) => row.scope ?? "—" },
      },
      {
        key: "sourceRole",
        header: "Role",
        filter: { type: "enum", accessor: (row) => row.sourceRole ?? "—" },
      },
      {
        key: "confidence",
        header: "Confidence",
        filter: { type: "enum", accessor: (row) => row.confidence ?? "—" },
      },
    ],
    [],
  );
  const cf = useColumnFilters(filterColumns, scopedRows, { ns: "obs" });
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cf.rows.filter((row) => {
      if (signalFilter && (row.kind ?? "other") !== signalFilter) return false;
      if (!q) return true;
      return `${row.title} ${row.body ?? ""} ${row.kind ?? ""} ${row.refs.join(" ")}`
        .toLowerCase()
        .includes(q);
    });
  }, [cf.rows, search, signalFilter]);
  const total = readListTotal(query.data);
  const hasMore = allRows.length < total;
  const isFiltered =
    cf.hasActive || search.trim() !== "" || signalFilter !== null;
  // The ONE shared count label (D-001: mimic the Work Queue). This pane may
  // adopt it because it satisfies the helper's precondition — it grows its
  // fetch window at the scroll edge (onEndReached → loadMore → limit +=
  // OBSERVATIONS_PAGE), so a filter can actually reach `total`.
  //
  // This deliberately RETIRES the old "N loaded / total" unfiltered form. That
  // form reported how many rows happened to be in memory, which is an artifact
  // of scroll position, not an answer to any question a user has — and it read
  // as a shortfall ("200 / 36,096") on a pane that was working correctly.
  const counts = filterCountLabel(rows.length, total, isFiltered, "observation");

  // Build signal counts from the real database counts, not loaded rows
  const signalCounts = useMemo(() => {
    const realCounts = countsQuery.data ?? [];
    const counts = new Map<string, number>();
    for (const row of realCounts) {
      counts.set(row.kind || "other", row.count);
    }
    return [...counts.entries()].sort((a, b) => {
      if (a[0] === "other") return 1;
      if (b[0] === "other") return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
  }, [countsQuery.data]);

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

  // Staleness tone: based on the newest observation's age
  const newestCreatedAt = allRows[0]?.createdAt ?? null;
  const stalenessLevel = getStalenessFromNewest(newestCreatedAt);

  useEffect(() => {
    onStatus?.(
      query.error ? "bad" : scopedRows.length > 0 ? "good" : "neutral",
    );
  }, [onStatus, query.error, scopedRows.length]);

  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch — LearningTab
  // renders this panel as its "observations" view and begins the interaction on
  // the view change (EI-19375505819043214).
  //
  // Gated on the OBSERVATIONS read only, deliberately NOT on countsQuery: the
  // counts are a secondary read for the signal chips, and on the live operator
  // learning.observations.counts currently 500s on every call, so waiting for
  // it would never settle and this interaction would measure nothing on the one
  // surface it was added to watch.
  //
  // endInteraction is measure-once and no-ops without a matching begin, so this
  // stays inert when the panel mounts outside a Learning-tab view switch.
  //
  // Gated on `active` as well as `settled`: LearningTab keeps this pane MOUNTED
  // when the user switches away, so on a revisit `settled` is already true and
  // never changes — an effect keyed on it alone would never re-run and the
  // switch would measure nothing (EI-19383745196363732).
  const settled = Boolean(
    !query.loading && (query.data !== undefined || query.error),
  );
  useInteractionSettle(PERF_INTERACTIONS.learningViewSwitch, settled, active);
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
          // Expanded + the body subsumes the truncated title ⇒ re-split the BODY
          // at a sentence boundary (headline + rest) instead of repeating the
          // title's text; otherwise keep title as headline and body as-is.
          const subsumed =
            selected && row.body ? bodySubsumesTitle(row.title, row.body) : false;
          const split = subsumed ? splitBodyHeadline(row.body ?? "") : null;
          const headline = split ? split.headline : row.title;
          const bodyTail = selected ? (split ? split.rest || null : row.body) : null;
          return (
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
                <strong>{headline}</strong>
                {selected && bodyTail ? (
                  <span className="pc-observations__body">{bodyTail}</span>
                ) : null}
                {selected && context ? (
                  <em className="pc-observations__context">{context}</em>
                ) : null}
              </span>
            </button>
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
        <label className="pc-observations__search">
          <Search size={12} aria-hidden />
          <input
            type="text"
            value={search}
            onChange={(e) => void setSearch(e.target.value)}
            placeholder="Search observations…"
            aria-label="Search observations"
          />
        </label>
        <ColumnFilterBar
          controller={cf.controller}
          activeChips={cf.activeChips}
          hasActive={cf.hasActive}
          clearAll={cf.clearAll}
        />
        {signalCounts.length > 0 ? (
          <div
            className="pc-observations__distribution"
            aria-label="Signal distribution (database counts)"
            data-staleness={stalenessLevel}
          >
            {signalCounts.map(([kind, count]) => (
              <Tooltip
                key={kind}
                label={`${KIND_LABEL[kind] ?? kind}: ${count.toLocaleString()}`}
              >
                <button
                  type="button"
                  aria-label={`Filter by ${KIND_LABEL[kind] ?? kind}, ${count.toLocaleString()}`}
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
                  <strong>{formatCount(count)}</strong>
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
        {total > 0 ? (
          <span
            data-testid="observations-count"
            aria-label={counts.summary}
            title={
              isFiltered
                ? "Observations matching the current filter / search, out of the total"
                : "Observations available"
            }
            style={{
              color: "var(--fg-mute)",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {isFiltered
              ? `${rows.length.toLocaleString()} of ${total.toLocaleString()}`
              : `${allRows.length.toLocaleString()} / ${total.toLocaleString()}`}
          </span>
        ) : null}
        <div
          className="pc-observations__viewtoggle"
          role="group"
          aria-label="Observation view"
        >
          <button
            type="button"
            aria-pressed={obsView === "table"}
            aria-label="Table view"
            onClick={() => void setObsView("table")}
          >
            <Table2 size={13} aria-hidden />
          </button>
          <button
            type="button"
            aria-pressed={obsView === "stacks"}
            aria-label="Stacked cards view"
            onClick={() => void setObsView("stacks")}
          >
            <Layers size={13} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="pc-advpanel__iconbtn"
          aria-label="Refresh observations"
          disabled={query.fetching}
          onClick={() => {
            query.invalidate();
            countsQuery.invalidate();
          }}
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
          {isFiltered || itemPlans.length
            ? "No observations match the current filter / search."
            : "No observations yet — they appear as agents reflect at the end of their turns."}
        </div>
      ) : obsView === "stacks" ? (
        <ObservationStacks rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
      ) : (
        <VirtualGrid<ObservationRow>
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          rowMinHeight={44}
          headerHeight={30}
          // An expanded row grows past rowMinHeight; without measurement the
          // virtualizer keeps the 44px slot and clips the body mid-line.
          measureVariableHeight
          onEndReached={hasMore ? loadMore : undefined}
        />
      )}
      <style>{`
        .pc-observations__toolbar { min-height: 30px; display: flex; align-items: center; justify-content: flex-end; gap: 9px; flex-wrap: wrap; }
        .pc-observations__search { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--fg-mute); }
        .pc-observations__search:focus-within { border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); color: var(--fg); }
        .pc-observations__search input { border: 0; background: none; outline: none; color: var(--fg); font: inherit; font-size: 11px; width: 150px; }
        .pc-observations__search input::placeholder { color: var(--fg-mute); }
        .pc-observations__viewtoggle { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
        .pc-observations__viewtoggle button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 22px; border: 0; border-radius: 6px; background: none; color: var(--fg-mute); cursor: pointer; }
        .pc-observations__viewtoggle button:hover { color: var(--fg); }
        .pc-observations__viewtoggle button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 16%, var(--bg-2)); color: var(--fg); }
        .pc-observations__stacks { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; align-content: start; padding: 2px; }
        /* The kind label + count render as CardStack's on-card header badge. */
        .pc-observations__stackgroup { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
        .pc-observations__kinddot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
        .pc-observations__card { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 0 12px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2); color: inherit; text-align: left; font: inherit; cursor: pointer; }
        /* Accent header band (design pass 2026-07-19f), tinted by the deck's
           kind color via --cs-accent. */
        .pc-observations__card-head {
          margin: 0 -12px 2px; padding: 7px 12px 6px;
          background: linear-gradient(
            color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 10%, transparent),
            color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 3%, transparent));
          border-bottom: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 16%, var(--border));
        }
        .pc-observations__card:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
        .pc-observations__card.is-selected { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
        .pc-observations__card-head { display: flex; align-items: center; gap: 8px; }
        .pc-observations__card-title { font-size: 12.5px; font-weight: 620; color: var(--fg); overflow-wrap: anywhere; }
        .pc-observations__card.is-selected .pc-observations__card-title { color: var(--accent); }
        .pc-observations__distribution { display: flex; flex: 1 1 auto; align-items: center; gap: 5px; min-width: 0; overflow-x: auto; opacity: 1; transition: opacity 140ms ease; }
        .pc-observations__distribution[data-staleness="stale"] { opacity: 0.72; }
        .pc-observations__distribution[data-staleness="very-stale"] { opacity: 0.5; }
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
        .pc-observations__copy > strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-observations__copy > strong { font-size: 12px; font-weight: 620; }
        /* An expanded row shows the FULL head — wrap instead of ellipsizing. */
        .pc-observations__entry.is-selected .pc-observations__copy > strong { white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; }
        .pc-observations__body, .pc-observations__context { display: block; color: var(--fg-mute); font-size: 10.5px; line-height: 1.4; }
        .pc-observations__body { overflow-wrap: anywhere; white-space: normal; }
        .pc-observations__context { overflow-wrap: anywhere; font-style: normal; white-space: normal; }
        .pc-observations__time { display: block; overflow: hidden; color: var(--fg-mute); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
        .pc-observations__sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      `}</style>
    </div>
  );
}

/**
 * #7 (owner ask 2026-07-19): the Stacks view — observations of the SAME kind
 * overlap into one deck the user browses one card at a time (via CardStack).
 * Groups render biggest-first with "other" pinned last, mirroring the count
 * chips' ordering so the two views read consistently.
 */
function ObservationStacks({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ObservationRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const groups = useMemo(() => {
    const byKind = new Map<string, ObservationRow[]>();
    for (const row of rows) {
      const kind = row.kind ?? "other";
      const bucket = byKind.get(kind);
      if (bucket) bucket.push(row);
      else byKind.set(kind, [row]);
    }
    return [...byKind.entries()].sort((a, b) => {
      if (a[0] === "other") return 1;
      if (b[0] === "other") return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });
  }, [rows]);
  return (
    <div className="pc-observations__stacks">
      {groups.map(([kind, group]) => (
        <section
          key={kind}
          className="pc-observations__stackgroup"
          aria-label={`${KIND_LABEL[kind] ?? kind} observations`}
        >
          <CardStack
            items={group}
            getKey={(row) => row.id}
            ariaLabel={`${KIND_LABEL[kind] ?? kind} observations`}
            accent={OBSERVATION_KIND_COLOR[kind]}
            // The kind badge rides ON the active card's top edge (CardStack
            // renders it overlapping), keeping it attached to its deck.
            header={
              <>
                <i
                  className="pc-observations__kinddot"
                  aria-hidden
                  style={{
                    background:
                      OBSERVATION_KIND_COLOR[kind] ?? "var(--fg-mute)",
                  }}
                />
                <span className="pc-cardstack__header-label">
                  {KIND_LABEL[kind] ?? kind}
                </span>
                <span className="pc-cardstack__header-count">
                  {group.length}
                </span>
              </>
            }
            renderCard={(row) => (
              <ObservationCard
                row={row}
                selected={selectedId === row.id}
                onToggle={() =>
                  onSelect(selectedId === row.id ? null : row.id)
                }
              />
            )}
          />
        </section>
      ))}
    </div>
  );
}

function ObservationCard({
  row,
  selected,
  onToggle,
}: {
  row: ObservationRow;
  selected: boolean;
  onToggle: () => void;
}) {
  const context = [row.sourceRole, row.scope, row.confidence, ...row.refs]
    .filter(Boolean)
    .join(" · ");
  const subsumed =
    selected && row.body ? bodySubsumesTitle(row.title, row.body) : false;
  const split = subsumed ? splitBodyHeadline(row.body ?? "") : null;
  const headline = split ? split.headline : row.title;
  const bodyTail = selected ? (split ? split.rest || null : row.body) : null;
  return (
    <button
      type="button"
      className={`pc-observations__card${selected ? " is-selected" : ""}`}
      aria-expanded={selected}
      aria-label={`${selected ? "Collapse" : "Expand"} observation ${row.title}`}
      onClick={onToggle}
    >
      <span className="pc-observations__card-head">
        <span className="pc-observations__time">
          {new Date(row.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </span>
      <strong className="pc-observations__card-title">{headline}</strong>
      {selected && bodyTail ? (
        <span className="pc-observations__body">{bodyTail}</span>
      ) : null}
      {selected && context ? (
        <em className="pc-observations__context">{context}</em>
      ) : null}
    </button>
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
