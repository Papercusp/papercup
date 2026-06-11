'use client';

// adv:agents — WHO'S WORKING HERE for the selected harness
// (progress-tab-agents-convergence-2026-06-11 P-003).
//
// Two sub-views behind a nuqs toggle:
//   - working (default): the fleet:assignments projection scoped to this
//     harness via `fleetAssignments.byHarness` — every agent with claims or
//     spawns here (psu sessions included), tagged with the colony tab's kind
//     glyph (♛/🐝/🛡/📋/🛠), its head-of-line work item, and its load. Same
//     vocabulary as zellij, narrower lens (plan D-001).
//   - runs: the original run-history grid (`agentRunsConsolidated.bySlug` via
//     useHarnessAgents) — "what executed here", kept as history, not deleted.
//
// Role colours come from the canonical getRoleStyle() in app/harness/theme.ts
// so a role renders the same hue on every surface.

import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { LIVE_MS, STALE_MS } from '@papercusp/operator-core/lib/liveness';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { getRoleStyle } from '../../harness/theme';
import { Tooltip } from '../../harness/Tooltip';
import { LivenessDot, livenessFromHeartbeat } from '../../coord/presence-ui';
import { useHarnessAgents, type HarnessAgentRun } from './useHarnessData';

// The colony tab's kind vocabulary (apps/tui agent_pane_kind.rs glyphs) —
// shared so the desktop and zellij read the same at a glance.
const KIND_GLYPH: Record<string, string> = {
  queen: '♛',
  bee: '🐝',
  sentinel: '🛡',
  planner: '📋',
  su: '🛠',
};

// Compact legend for the glyph column (owner ask 2026-06-11) — same order as
// the pui colony roster; the tooltip carries the one-line "what is this kind".
const KIND_LEGEND: Array<{ kind: string; hint: string }> = [
  { kind: 'queen', hint: 'Queen — the autonomous brain session (cadence-driven)' },
  { kind: 'bee', hint: 'Bee — Queen-spawned headless worker (invoke-once); ephemeral' },
  { kind: 'sentinel', hint: 'Sentinel — the always-on, owner-facing operator chat persona' },
  { kind: 'planner', hint: 'Planner — plan-authoring session from the New-plan flow' },
  { kind: 'su', hint: 'SU — an interactive engineer (psu) session, self-claims work' },
];

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
interface WorkingAgent {
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

export default function AdvAgentsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  // Sub-view: who's working (presence/claims) vs what executed (run history).
  const [view, setView] = useQueryState(
    'agentsView',
    parseAsStringEnum<'working' | 'runs'>(['working', 'runs']).withDefault('working'),
  );

  if (!slug) {
    return <div className="pc-adv-agents__empty">No harness slug in params.</div>;
  }

  return (
    <div className="pc-adv-agents">
      <div className="pc-adv-agents__bar">
        <div className="pc-adv-agents__views" role="tablist" aria-label="Agents sub-view">
          {(['working', 'runs'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className="pc-adv-agents__view-tab"
              onClick={() => void setView(v)}
            >
              {v === 'working' ? 'Working' : 'Runs'}
            </button>
          ))}
        </div>
        <span className="pc-adv-agents__bar-rest" id="pc-adv-agents-bar-slot" />
        {view === 'working' ? (
          <span className="pc-adv-agents__legend" aria-label="Agent kind and liveness legend">
            {KIND_LEGEND.map(({ kind, hint }) => (
              <Tooltip key={kind} label={hint}>
                <span className="pc-adv-agents__legend-item">
                  {KIND_GLYPH[kind]} {kind}
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
          </span>
        ) : null}
      </div>
      {view === 'working' ? <WorkingView slug={slug} /> : <RunsView slug={slug} />}
      <PanelStyles />
    </div>
  );
}

/** "Who's working here" — the fleet:assignments projection (plan P-003). */
function WorkingView({ slug }: { slug: string }) {
  const query = useSyncQuery<WorkingAgent>({
    queryName: 'fleetAssignments.byHarness',
    args: { harnessSlug: slug },
    enabled: Boolean(slug),
  });
  const agents = query.loading ? null : query.data;
  const [, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));

  const rows = useMemo(() => {
    // Live agents first, loaded first within liveness.
    return [...(agents ?? [])].sort(
      (a, b) => Number(b.alive) - Number(a.alive) || b.load - a.load,
    );
  }, [agents]);

  const columns: ColumnDef<WorkingAgent>[] = [
    {
      key: 'kind',
      header: '',
      headerText: '',
      width: '30px',
      toCopyText: (r) => r.agentPaneKind,
      // Native title=, not <Tooltip>: per-row hints in grid cells — a Radix
      // portal per row is the documented perf anti-pattern (design/gotchas).
      render: ({ row }) => (
        <span
          className={`pc-adv-agents__kind${row.alive ? '' : ' is-dead'}`}
          title={`${row.agentPaneKind}${row.alive ? '' : ' (not live)'}`}
        >
          {KIND_GLYPH[row.agentPaneKind] ?? '·'}
        </span>
      ),
    },
    {
      key: 'agent',
      header: 'Agent',
      headerText: 'Agent',
      width: '140px',
      toCopyText: (r) => r.agentId,
      render: ({ row }) => (
        <span className="pc-adv-agents__run" title={row.intent || row.agentId}>
          {row.name ?? row.label ?? row.agentId}
        </span>
      ),
    },
    {
      key: 'doing',
      header: 'Doing',
      headerText: 'Doing',
      width: 1,
      toCopyText: (r) => r.doing?.id ?? '',
      render: ({ row }) => (
        <span className="pc-adv-agents__cellrow">
          {row.doing ? (
            <>
              <span className="pc-adv-agents__feat">{row.doing.id}</span>
              <span className="pc-adv-agents__doing">{row.doing.title}</span>
            </>
          ) : (
            <span className="pc-adv-agents__doing pc-adv-agents__doing--idle">
              {row.intent || (row.declaredUnclaimed ? '⚠ declared, unclaimed' : '—')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'load',
      header: 'Load',
      headerText: 'Load',
      width: '46px',
      align: 'right',
      toCopyText: (r) => String(r.load),
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

  return (
    <div className="pc-adv-agents__list">
      {query.error ? (
        <div className="pc-adv-agents__empty pc-adv-agents__empty--err">
          Failed: {query.error.message}
        </div>
      ) : agents === null ? (
        <div className="pc-adv-agents__empty">Loading {slug}…</div>
      ) : (
        <RichGrid<WorkingAgent>
          columns={columns}
          rows={rows}
          resizableColumns
          getRowId={(r) => r.agentId}
          onRowClick={(r) => {
            if (r.doing) void setSelectedId(r.doing.id);
          }}
          headerHeight={26}
          rowMinHeight={32}
          headerStyle={{
            background: 'var(--bg-2, rgba(255,255,255,0.045))',
            color: 'var(--fg-mute, #7f9bb4)',
            borderBottom:
              '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
          empty={
            <div className="pc-adv-agents__empty">
              No agents working in {slug} right now — claims and spawns land here live.
            </div>
          }
        />
      )}
    </div>
  );
}

/** The original run-history grid — "what executed here" (kept per plan D-001). */
function RunsView({ slug }: { slug: string }) {
  const { agents, loading, error, refresh } = useHarnessAgents(slug);
  // showAll persists in the URL (nuqs) so it survives reload + is agent-driveable.
  const [showAll, setShowAll] = useQueryState('agentsAll', parseAsBoolean.withDefault(false));
  // Clicking a row with a feature jumps the Detail pane to that feature.
  const [, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo<HarnessAgentRun[]>(() => {
    if (!agents) return [];
    const xs = showAll ? agents : agents.filter((r) => r.running);
    // Most recent first (running rows float up via lastEventTs/ts).
    return [...xs].sort((a, b) => (b.lastEventTs ?? b.ts ?? 0) - (a.lastEventTs ?? a.ts ?? 0));
  }, [agents, showAll]);

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 12,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [visible, rowVirtualizer]);

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
            <span className="pc-adv-agents__run" title={row.runId}>{row.runId}</span>
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
      <div className="pc-adv-agents__bar pc-adv-agents__bar--sub">
        <button
          type="button"
          className="pc-adv-agents__toggle"
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
            className="pc-adv-agents__refresh"
            onClick={() => refresh()}
            aria-label="Refresh agent runs"
          >
            <RefreshCw size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="pc-adv-agents__list">
        {error ? (
          <div className="pc-adv-agents__empty pc-adv-agents__empty--err">Failed: {error}</div>
        ) : loading ? (
          <div className="pc-adv-agents__empty">Loading {slug}…</div>
        ) : (
          <RichGrid<HarnessAgentRun>
            inline
            resizableColumns
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: visible.length,
              rowAt: (i) => visible[i],
            }}
            columns={columns}
            getRowId={(r) => r.runId}
            onRowClick={(r) => {
              if (r.featureId) void setSelectedId(r.featureId);
            }}
            headerHeight={26}
            rowMinHeight={32}
            headerStyle={{
              background: 'var(--bg-2, rgba(255,255,255,0.045))',
              color: 'var(--fg-mute, #7f9bb4)',
              borderBottom:
                '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
            empty={
              <div className="pc-adv-agents__empty">
                {showAll ? 'No agent runs for this harness yet.' : 'No agents running.'}
              </div>
            }
          />
        )}
      </div>
    </>
  );
}

function PanelStyles() {
  return (
    <style>{`
      .pc-adv-agents { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1, #0b1220); }
      .pc-adv-agents__bar {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px; flex-shrink: 0;
        border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
      }
      .pc-adv-agents__bar--sub { border-bottom: 0; padding-bottom: 0; }
      .pc-adv-agents__views { display: inline-flex; gap: 2px; }
      .pc-adv-agents__view-tab {
        padding: 2px 10px; font-size: 11px; color: var(--fg-mute);
        background: transparent; border: 1px solid transparent;
        border-radius: 999px; cursor: pointer;
      }
      .pc-adv-agents__view-tab[aria-selected="true"] {
        color: var(--fg);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
      }
      .pc-adv-agents__bar-rest { margin-left: auto; }
      .pc-adv-agents__legend {
        display: inline-flex; gap: 10px; flex-shrink: 1; min-width: 0;
        overflow: hidden; white-space: nowrap;
        font-size: 10px; color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-agents__legend-item { display: inline-flex; align-items: center; gap: 3px; cursor: default; }
      .pc-adv-agents__legend-gap { width: 6px; border-left: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%)); }
      .pc-adv-agents__kind { font-size: 13px; line-height: 1; }
      .pc-adv-agents__kind.is-dead { opacity: 0.45; filter: grayscale(0.8); }
      .pc-adv-agents__doing {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 11.5px; color: var(--fg, #e7f7ff);
      }
      .pc-adv-agents__doing--idle { color: var(--fg-mute); font-style: italic; }
      .pc-adv-agents__toggle {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 2px 9px; font-size: 11px; color: var(--fg);
        background: transparent;
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        border-radius: 999px; cursor: pointer;
      }
      .pc-adv-agents__toggle[aria-pressed="true"] {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
      }
      .pc-adv-agents__count { font-variant-numeric: tabular-nums; color: var(--fg-mute); font-size: 10px; }
      .pc-adv-agents__hint { font-size: 10px; color: var(--fg-mute); }
      .pc-adv-agents__refresh {
        margin-left: auto; display: inline-flex; align-items: center;
        padding: 4px; color: var(--fg-mute); background: transparent;
        border: 0; border-radius: 4px; cursor: pointer;
      }
      .pc-adv-agents__refresh:hover { color: var(--fg); border-color: var(--accent); }
      .pc-adv-agents__list { flex: 1; min-height: 0; overflow: auto; }
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
        flex: 1; min-width: 0; font-family: ui-monospace, monospace; font-size: 10px;
        color: var(--fg-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-adv-agents__feat {
        font-family: ui-monospace, monospace; font-size: 10px; flex-shrink: 0;
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-adv-agents__num {
        font-size: 10px; color: var(--fg-mute); font-variant-numeric: tabular-nums;
      }
      .pc-adv-agents__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); }
      .pc-adv-agents__empty--err { color: var(--bad, #f87171); }
    `}</style>
  );
}
