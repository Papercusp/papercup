'use client';

// adv:agents — WHO'S WORKING HERE for the selected harness
// (progress-tab-agents-convergence-2026-06-11 P-003).
//
// Two sub-views behind a nuqs toggle:
//   - working (default): the fleet:assignments projection scoped to this
//     harness via `fleetAssignments.byHarness` — every agent with claims or
//     spawns here (psu sessions included), tagged with the colony tab's kind
//     glyph (♛/👁/☕/🛡/📋/🛠), its head-of-line work item, and its load. Same
//     vocabulary as zellij, narrower lens (plan D-001).
//   - runs: the original run-history grid (`agentRunsConsolidated.bySlug` via
//     useHarnessAgents) — "what executed here", kept as history, not deleted.
//
// Visual language: WorkItemsPanel is the reference design for the whole dock
// (adv-panel-chrome.css) — same bar furniture (filter input · kind Select ·
// refresh), same chip pills (<AgentKindPill> joins the KindPill family), same
// grid conventions (proportional widths, <code> ids, native title= truncation,
// `?sel` row highlight). Role colours come from the canonical getRoleStyle()
// in app/harness/theme.ts so a role renders the same hue on every surface.

import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { VirtualGrid, usePersistedColumnWidths, type ColumnDef } from '@papercusp/grid-core';
import { LIVE_MS, STALE_MS } from '@papercusp/operator-core/lib/liveness';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { getRoleStyle } from '../../harness/theme';
import { Select } from '../../harness/Select';
import { Tooltip } from '../../harness/Tooltip';
import { AgentKindPill, AGENT_KIND_GLYPH } from '../../harness/primitives';
import { LivenessDot, livenessFromHeartbeat } from '../../coord/presence-ui';
import { useColumnFilters, ColumnFilterBar } from '../../harness/filters';
import { useLexicon } from '@/lib/useLexicon';
import { useHarnessAgents, type HarnessAgentRun } from './useHarnessData';

// Compact legend for the kind pills (owner ask 2026-06-11) — same order as
// the pui colony roster; the tooltip carries the one-line "what is this kind".
// `kind` stays the internal pane-kind id (glyph lookup + React key, plan D-001);
// the display `label` + `hint` route the user-facing role words through the
// lexicon (queen→Brain, bee→Cup, sentinel→Operator — restore-pot-lexicon P-007).
// Built at render time (see kindLegend) because the terms depend on the hook.
// overwatch/planner/su have no TermKey and stay literal.

// Liveness legend (owner ask 2026-06-11) — thresholds read straight off the
// canonical constants (lib/liveness — the same leaf deriveLiveness uses), so
// the labels can't drift from the derivation.
const fmtAgeBound = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`);
const LIVENESS_LEGEND: Array<{ liveness: 'live' | 'idle' | 'stale'; label: string; hint: string }> = [
  {
    liveness: 'live',
    label: `live <${fmtAgeBound(LIVE_MS)}`,
    hint: `Live — a heartbeat (tool call) within the last ${fmtAgeBound(LIVE_MS)}`,
  },
  {
    liveness: 'idle',
    label: `idle <${fmtAgeBound(STALE_MS)}`,
    hint: `Idle — last heartbeat ${fmtAgeBound(LIVE_MS)}–${fmtAgeBound(STALE_MS)} ago (may be mid-reasoning; heartbeats only fire on tool boundaries)`,
  },
  {
    liveness: 'stale',
    label: `stale ≥${fmtAgeBound(STALE_MS)}`,
    hint: `Stale — no heartbeat for ${fmtAgeBound(STALE_MS)}+ (session presumed ended)`,
  },
];

// One agent row from `fleetAssignments.byHarness` (the fleet:assignments
// AgentAssignment + the stamped pane kind — see sync-resolver/index.ts).
// Exported: DetailPanel resolves `?sel=agent:<id>` against the same query
// (the same shape-sharing WorkItemsPanel does with WorkItemRow).
export interface WorkingAgent {
  agentId: string;
  label: string | null;
  name: string | null;
  present: boolean;
  alive: boolean;
  heartbeatAt: string | null;
  intent: string;
  claims: Array<{ id: string | null; type: string; detail: string }>;
  orphaned: boolean;
  declaredUnclaimed: boolean;
  doing: { id: string; title: string; rank: number | null } | null;
  queued: Array<{ id: string }>;
  load: number;
  agentPaneKind: string;
  driveMode: string;
}

// Grid-cell truncation (native title= is the approved pattern for dynamic
// per-row truncation tooltips — see design/gotchas).
const CELL_TRUNCATE: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Selected-row tint — the same recipe WorkItemsPanel uses for `?sel`.
const SELECTED_ROW_BG = 'color-mix(in oklab, var(--accent), transparent 80%)';

// Radix Select reserves '' for "no selection" — translate at the boundary
// (the documented sentinel pattern from design/gotchas).
const ALL_KINDS = '_all';

function fmtAge(ms: number | undefined): string {
  if (!ms) return '—';
  const age = Math.max(0, Date.now() - ms);
  if (age < 60_000) return `${Math.floor(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  return `${Math.floor(age / 86_400_000)}d`;
}

function fmtBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export default function AdvAgentsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  // Sub-view: who's working (presence/claims) vs what executed (run history).
  const [view, setView] = useQueryState(
    'agentsView',
    parseAsStringEnum<'working' | 'runs'>(['working', 'runs']).withDefault('working'),
  );

  if (!slug) {
    return <div className="pc-advpanel__empty">No harness slug in params.</div>;
  }

  // Sub-view tabs lead the (single) toolbar, Work-items style — each view
  // renders the rest of its own bar so its controls sit beside the tabs
  // instead of stacking a second bar.
  const viewTabs = (
    <div className="pc-adv-agents__views" role="tablist" aria-label="Agents sub-view">
      {(['working', 'runs'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          className="pc-advpanel__chip"
          onClick={() => void setView(v)}
        >
          {v === 'working' ? 'Working' : 'Runs'}
        </button>
      ))}
    </div>
  );

  return (
    <div className="pc-advpanel pc-adv-agents">
      {view === 'working' ? (
        <WorkingView slug={slug} api={api} viewTabs={viewTabs} />
      ) : (
        <RunsView slug={slug} api={api} viewTabs={viewTabs} />
      )}
      <PanelStyles />
    </div>
  );
}

/** "Who's working here" — the fleet:assignments projection (plan P-003). */
function WorkingView({
  slug,
  api,
  viewTabs,
}: {
  slug: string;
  api: PanelComponentProps['api'];
  viewTabs: ReactNode;
}) {
  // user-meaningful filters → URL (nuqs); `a`-prefixed so they don't collide
  // with the Work-items panel's (wkind/wq) in the same dock.
  const [kind, setKind] = useQueryState('akind', parseAsString.withDefault(''));
  const [search, setSearch] = useQueryState('aq', parseAsString.withDefault(''));
  // Row click selects the AGENT in the Detail pane via the global `?sel` —
  // the same contract Work items has, namespaced `agent:<agentId>` so the
  // prefix router in DetailPanel can tell it apart from F-*/I-*/WI-* ids.
  // (The agent's head-of-line work item is one click away inside the agent
  // detail's "Working on" cross-link.)
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  // Dragged widths survive panel remounts (localStorage — render-only pref).
  const [colWidths, setColWidths] = usePersistedColumnWidths('pc-colw:adv:agents-working');

  const query = useSyncQuery<WorkingAgent>({
    queryName: 'fleetAssignments.byHarness',
    args: { harnessSlug: slug },
    enabled: Boolean(slug),
  });
  const agents = query.loading ? null : query.data;
  const loading = query.fetching;
  const error = query.error ? query.error.message : null;

  useEffect(() => {
    if (agents) api.setTitle(`Agents · ${slug} (${agents.length})`);
  }, [agents, slug, api]);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents ?? []) set.add(a.agentPaneKind);
    return Array.from(set).sort();
  }, [agents]);

  const t = useLexicon();
  // Render-time kind legend — internal `kind` id kept for the glyph/key (plan
  // D-001); the user-facing role words routed through the lexicon (queen→Brain,
  // bee→Cup, sentinel→Operator — restore-pot-lexicon P-007). overwatch/planner/su
  // have no TermKey and stay literal.
  const kindLegend: Array<{ kind: string; label: string; hint: string }> = [
    { kind: 'queen', label: t('brain', { lower: true }), hint: `${t('brain')} — the autonomous brain session (cadence-driven)` },
    { kind: 'overwatch', label: 'overwatch', hint: `Overwatch — the autonomous system-health supervisor (a ${t('brain')} sibling); watches + nudges, never edits` },
    { kind: 'bee', label: t('contributor', { lower: true }), hint: `${t('contributor')} — ${t('brain')}-spawned headless worker (invoke-once); ephemeral` },
    { kind: 'sentinel', label: t('operator', { lower: true }), hint: `${t('operator')} — the always-on, owner-facing operator chat persona` },
    { kind: 'planner', label: 'planner', hint: 'Planner — plan-authoring session from the New-plan flow' },
    { kind: 'su', label: 'su', hint: 'SU — an interactive engineer (psu) session, self-claims work' },
  ];

  const columns: ColumnDef<WorkingAgent>[] = [
    {
      key: 'kind',
      header: 'Kind',
      width: 1.2,
      toCopyText: (r) => r.agentPaneKind,
      filter: { type: 'enum', accessor: (r) => r.agentPaneKind },
      // Canonical agent-kind chip (AGENT_KIND table) — same chip recipe as the
      // Work-items Kind column so the dock's pill columns read as one visual
      // language. Native title=, not <Tooltip>: per-row hints in grid cells —
      // a Radix portal per row is the documented perf anti-pattern
      // (design/gotchas).
      render: ({ row }) => (
        <span
          className={row.alive ? undefined : 'pc-adv-agents__dead'}
          title={`${row.agentPaneKind}${row.alive ? '' : ' (not live)'}`}
        >
          <AgentKindPill kind={row.agentPaneKind} size="xs" />
        </span>
      ),
    },
    {
      key: 'agent',
      header: 'Agent',
      width: 1.8,
      toCopyText: (r) => r.agentId,
      // Text-match the displayed identity (name/label/id) — the same string the
      // cell shows and the legacy quick-search keys off.
      filter: { type: 'text', accessor: (r) => r.name ?? r.label ?? r.agentId },
      render: ({ row }) => (
        <span style={CELL_TRUNCATE} title={row.intent || row.agentId}>
          {row.name ?? row.label ?? row.agentId}
        </span>
      ),
    },
    {
      key: 'item',
      header: 'Item',
      width: 1.4,
      toCopyText: (r) => r.doing?.id ?? '',
      filter: { type: 'text', accessor: (r) => r.doing?.id ?? null },
      render: ({ row }) =>
        row.doing ? (
          <code style={CELL_TRUNCATE} title={row.doing.id}>{row.doing.id}</code>
        ) : (
          <>—</>
        ),
    },
    {
      key: 'doing',
      header: 'Doing',
      width: 4,
      toCopyText: (r) => r.doing?.title ?? r.intent,
      // Match what the cell renders: the work-item title when claimed, else the
      // declared intent.
      filter: { type: 'text', accessor: (r) => r.doing?.title ?? r.intent },
      render: ({ row }) =>
        row.doing ? (
          <span style={CELL_TRUNCATE} title={row.doing.title}>{row.doing.title}</span>
        ) : (
          <span style={CELL_TRUNCATE} className="pc-adv-agents__idle" title={row.intent || undefined}>
            {row.intent || (row.declaredUnclaimed ? '⚠ declared, unclaimed' : '—')}
          </span>
        ),
    },
    {
      key: 'load',
      header: 'Load',
      width: '52px',
      align: 'right',
      toCopyText: (r) => String(r.load),
      filter: { type: 'number', accessor: (r) => r.load },
      render: ({ row }) => (
        <span className="pc-adv-agents__num">
          {row.load > 0 ? `⇄${row.load}` : row.claims.length > 0 ? `▣${row.claims.length}` : '—'}
        </span>
      ),
    },
    {
      key: 'live',
      header: '',
      headerText: 'Live',
      width: '40px',
      align: 'right',
      filter: { type: 'boolean', accessor: (r) => r.alive },
      render: ({ row }) => {
        // The 3-state dot (live/idle/stale — see LIVENESS_LEGEND) derived from
        // the row's own heartbeat, same scale as the sessions roster. A row
        // with no heartbeat reads stale.
        const liveness = livenessFromHeartbeat(row.heartbeatAt ?? '');
        return (
          <span
            style={{ display: 'inline-flex' }}
            title={`${liveness} — heartbeat ${row.heartbeatAt ?? 'never'}`}
          >
            <LivenessDot liveness={liveness} title="" />
          </span>
        );
      },
    },
  ];

  // Generic per-column filters (kind/agent/item/doing/load/live) → ONE nuqs param
  // `faf`. The bar self-gates on the flag; `cf.rows` is the input ref when nothing
  // is active (cheap fast-path).
  const cf = useColumnFilters(columns, agents ?? [], { ns: 'fa' });

  // The legacy kind Select (`akind`) + quick-search (`aq`) apply ON TOP of the
  // column-filtered rows, then the same liveness-first sort as before.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const xs = cf.rows.filter((a) => {
      if (kind && a.agentPaneKind !== kind) return false;
      if (q) {
        const hay = `${a.agentId} ${a.name ?? ''} ${a.label ?? ''} ${a.intent} ${a.doing?.id ?? ''} ${a.doing?.title ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Live agents first, loaded first within liveness.
    return [...xs].sort((a, b) => Number(b.alive) - Number(a.alive) || b.load - a.load);
  }, [cf.rows, kind, search]);

  return (
    <>
      <div className="pc-advpanel__bar">
        {viewTabs}
        <input
          type="text"
          className="pc-advpanel__input"
          value={search}
          onChange={(e) => void setSearch(e.target.value)}
          placeholder="Filter agents…"
          aria-label="Filter agents"
        />
        <ColumnFilterBar
          controller={cf.controller}
          activeChips={cf.activeChips}
          hasActive={cf.hasActive}
          clearAll={cf.clearAll}
        />
        <Select
          value={kind || ALL_KINDS}
          onChange={(v) => void setKind(v === ALL_KINDS ? '' : v)}
          ariaLabel="Filter by agent kind"
          triggerClassName="pc-advpanel__select"
          options={[
            { value: ALL_KINDS, label: 'all kinds' },
            ...kinds.map((k) => ({ value: k, label: `${AGENT_KIND_GLYPH[k] ?? '·'} ${k}` })),
          ]}
        />
        <Tooltip label="Refresh agents">
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            onClick={() => query.invalidate()}
            disabled={loading}
            aria-label="Refresh agents"
          >
            <RefreshCw size={13} aria-hidden className={loading ? 'pc-advpanel__spin' : undefined} />
          </button>
        </Tooltip>
      </div>
      {error ? (
        <div className="pc-advpanel__empty pc-advpanel__empty--err">Failed: {error}</div>
      ) : !agents ? (
        <div className="pc-advpanel__empty">Loading {slug}…</div>
      ) : filtered.length === 0 ? (
        <div className="pc-advpanel__empty">
          {agents.length === 0
            ? `No agents working in ${slug} right now — claims and spawns land here live.`
            : 'No agents match the filter.'}
        </div>
      ) : (
        <VirtualGrid<WorkingAgent>
          columns={columns}
          rows={filtered}
          resizableColumns
          columnWidths={colWidths}
          onColumnWidthsChange={setColWidths}
          getRowId={(r) => r.agentId}
          onRowClick={(r) => void setSelectedId(`agent:${r.agentId}`)}
          getRowBg={(r) => (`agent:${r.agentId}` === selectedId ? SELECTED_ROW_BG : undefined)}
          headerHeight={30}
          rowMinHeight={30}
        />
      )}
      <div className="pc-adv-agents__legendbar" aria-label="Agent kind and liveness legend">
        {kindLegend.map(({ kind: k, label, hint }) => (
          <Tooltip key={k} label={hint}>
            <span className="pc-adv-agents__legend-item">
              {AGENT_KIND_GLYPH[k]} {label}
            </span>
          </Tooltip>
        ))}
        <span className="pc-adv-agents__legend-gap" aria-hidden />
        {LIVENESS_LEGEND.map(({ liveness, label, hint }) => (
          <Tooltip key={liveness} label={hint}>
            <span className="pc-adv-agents__legend-item">
              <LivenessDot liveness={liveness} size={7} title="" />
              {label}
            </span>
          </Tooltip>
        ))}
      </div>
    </>
  );
}

/** The original run-history grid — "what executed here" (kept per plan D-001). */
function RunsView({
  slug,
  api,
  viewTabs,
}: {
  slug: string;
  api: PanelComponentProps['api'];
  viewTabs: ReactNode;
}) {
  const { agents, loading, error, refresh } = useHarnessAgents(slug);
  // showAll persists in the URL (nuqs) so it survives reload + is agent-driveable.
  const [showAll, setShowAll] = useQueryState('agentsAll', parseAsBoolean.withDefault(false));
  // Dragged widths survive panel remounts (localStorage — render-only pref).
  const [colWidths, setColWidths] = usePersistedColumnWidths('pc-colw:adv:agents-runs');
  // Clicking a row with a feature jumps the Detail pane to that feature.
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));

  useEffect(() => {
    if (agents) api.setTitle(`Agents · ${slug} (${agents.length} runs)`);
  }, [agents, slug, api]);

  const visible = useMemo<HarnessAgentRun[]>(() => {
    if (!agents) return [];
    const xs = showAll ? agents : agents.filter((r) => r.running);
    // Most recent first (running rows float up via lastEventTs/ts).
    return [...xs].sort((a, b) => (b.lastEventTs ?? b.ts ?? 0) - (a.lastEventTs ?? a.ts ?? 0));
  }, [agents, showAll]);

  const columns = useMemo<ColumnDef<HarnessAgentRun>[]>(
    () => [
      {
        key: 'running',
        header: '',
        headerText: '',
        width: '22px',
        render: ({ row }) => (
          <span
            className={`pc-adv-agents__dot${row.running ? ' is-running' : ''}`}
            title={row.running ? 'running' : 'idle'}
          />
        ),
      },
      {
        key: 'role',
        header: 'Role',
        headerText: 'Role',
        width: '104px',
        toCopyText: (r) => r.role,
        render: ({ row }) => {
          const rs = getRoleStyle(row.role);
          return (
            <span className="pc-adv-agents__role">
              <span
                className="pc-adv-agents__role-dot"
                style={{ background: rs.solid }}
                aria-hidden
              />
              {rs.label.toLowerCase()}
            </span>
          );
        },
      },
      {
        key: 'run',
        header: 'Run',
        headerText: 'Run',
        width: 1,
        toCopyText: (r) => r.runId,
        render: ({ row }) => (
          <span className="pc-adv-agents__cellrow">
            <code className="pc-adv-agents__run" title={row.runId}>{row.runId}</code>
            {row.featureId ? <span className="pc-adv-agents__feat">{row.featureId}</span> : null}
          </span>
        ),
      },
      {
        key: 'size',
        header: 'Size',
        headerText: 'Size',
        width: '58px',
        align: 'right',
        toCopyText: (r) => fmtBytes(r.sizeBytes),
        render: ({ row }) => <span className="pc-adv-agents__num">{fmtBytes(row.sizeBytes)}</span>,
      },
      {
        key: 'age',
        header: 'Age',
        headerText: 'Age',
        width: '48px',
        align: 'right',
        render: ({ row }) => (
          <span
            className="pc-adv-agents__num"
            title={row.lastEventTs ? new Date(row.lastEventTs).toISOString() : undefined}
          >
            {fmtAge(row.lastEventTs ?? row.ts)}
          </span>
        ),
      },
    ],
    [],
  );

  const runningCount = agents?.filter((r) => r.running).length ?? 0;

  return (
    <>
      <div className="pc-advpanel__bar">
        {viewTabs}
        <button
          type="button"
          className="pc-advpanel__chip"
          aria-pressed={showAll}
          onClick={() => void setShowAll((v) => !v)}
        >
          {showAll ? 'All' : 'Running only'}{' '}
          <span className="pc-adv-agents__count">{visible.length}</span>
        </button>
        {!showAll && runningCount === 0 && agents && agents.length > 0 ? (
          <span className="pc-adv-agents__hint">{agents.length} total — none running</span>
        ) : null}
        <Tooltip label="Refresh agent runs">
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            style={{ marginLeft: 'auto' }}
            onClick={() => refresh()}
            disabled={loading}
            aria-label="Refresh agent runs"
          >
            <RefreshCw size={13} aria-hidden className={loading ? 'pc-advpanel__spin' : undefined} />
          </button>
        </Tooltip>
      </div>

      {error ? (
        <div className="pc-adv-agents__list">
          <div className="pc-advpanel__empty pc-advpanel__empty--err">Failed: {error}</div>
        </div>
      ) : loading ? (
        <div className="pc-adv-agents__list">
          <div className="pc-advpanel__empty">Loading {slug}…</div>
        </div>
      ) : (
        <VirtualGrid<HarnessAgentRun>
          scrollClassName="pc-adv-agents__list"
          resizableColumns
          columnWidths={colWidths}
          onColumnWidthsChange={setColWidths}
          rows={visible}
          columns={columns}
          getRowId={(r) => r.runId}
          onRowClick={(r) => {
            if (r.featureId) void setSelectedId(r.featureId);
          }}
          getRowBg={(r) => (r.featureId && r.featureId === selectedId ? SELECTED_ROW_BG : undefined)}
          headerHeight={30}
          rowMinHeight={30}
          empty={
            <div className="pc-advpanel__empty">
              {showAll ? 'No agent runs for this harness yet.' : 'No agents running.'}
            </div>
          }
        />
      )}
    </>
  );
}

function PanelStyles() {
  return (
    <style>{`
      .pc-adv-agents__views { display: inline-flex; gap: 4px; flex-shrink: 0; }
      .pc-adv-agents__dead { opacity: 0.45; filter: grayscale(0.8); }
      .pc-adv-agents__idle { color: var(--fg-mute); font-style: italic; }
      .pc-adv-agents__count { font-variant-numeric: tabular-nums; color: var(--fg-mute); font-size: 10px; }
      .pc-adv-agents__hint { font-size: 10px; color: var(--fg-mute); }
      .pc-adv-agents__list { flex: 1; min-height: 0; overflow: auto; }
      .pc-adv-agents__legendbar {
        display: flex; align-items: center; gap: 10px; flex-shrink: 0;
        margin-top: auto; padding: 5px 10px; overflow: hidden; white-space: nowrap;
        font-size: 10px; color: var(--fg-mute, #7f9bb4);
        border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
      }
      .pc-adv-agents__legend-item { display: inline-flex; align-items: center; gap: 3px; cursor: default; }
      .pc-adv-agents__legend-gap { width: 6px; border-left: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%)); align-self: stretch; }
      .pc-adv-agents__dot {
        display: inline-block; width: 7px; height: 7px; border-radius: 50%;
        background: color-mix(in oklab, var(--fg-mute), transparent 30%);
      }
      .pc-adv-agents__dot.is-running {
        background: var(--good, #4ade80);
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--good, #4ade80), transparent 78%);
      }
      .pc-adv-agents__role {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; font-weight: 600; color: var(--fg, #e7f7ff);
      }
      .pc-adv-agents__role-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
      .pc-adv-agents__cellrow { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; width: 100%; }
      .pc-adv-agents__run {
        flex: 1; min-width: 0; font-size: 11px;
        color: var(--fg-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-adv-agents__feat {
        font-family: ui-monospace, monospace; font-size: 10px; flex-shrink: 0;
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-adv-agents__num {
        color: var(--fg-mute); font-variant-numeric: tabular-nums;
      }
    `}</style>
  );
}
