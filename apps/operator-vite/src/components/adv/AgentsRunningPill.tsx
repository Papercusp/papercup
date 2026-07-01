/**
 * AgentsRunningPill — the always-visible header control that replaces the
 * overflowing per-agent run pills (AdvNowRunning) once there are more than a few
 * agents. A compact "⚡ N agents running" pill (with a colored dot per active
 * fleet); clicking it opens a popover with the WHOLE-workspace agent roster
 * GROUPED BY FLEET and COLORED BY FLEET — mirroring the zellij Fleet-tab roster
 * (apps/tui/src/fleet.rs). Reads the same push-driven `advRoster.list` sync query
 * the Sessions roster uses (workspace-wide, presence-primary; each entry carries
 * fleetSlug + fleetColor = the fleet's scheme.cursor accent).
 *
 * Phase 1 (this): the collapsed pill + the fleet-grouped, fleet-colored roster.
 * Phase 2 (A4): hover a row → preview its plans/work-items; click → live
 * inspector / jump to the item / reach the session.
 */
import { useEffect, useMemo, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Popover } from '@/app/harness/Popover';
import { LivenessDot } from '@/app/coord/presence-ui';
import AgentInspectorModal from '@/app/harness/AgentInspectorModal';
import { ThinkingDot } from '@/app/harness/AgentThinkingPopover';

/** The subset of a server RosterEntry (adv-roster.ts) this control reads. The
 *  fleet fields are stamped by resolveFleetInfoByOwner; the base frontend
 *  RosterEntry type doesn't declare them, so we type them here. */
export interface RosterAgent {
  ownerId: string;
  label: string;
  agent: string | null;
  role: string | null;
  intent: string;
  feature: string | null;
  currentPlanSlug: string | null;
  liveness: 'live' | 'idle' | 'stale' | string;
  heartbeatAt: string;
  fleetSlug?: string | null;
  fleetColor?: string | null;
  agentPaneKind?: string | null;
  /** The agent's latest run-id + its harness — present only for spawned runs
   *  (bees) that have a thinking log. Enables the "live thinking" click action;
   *  absent ⇒ no action shown (never a dead button). */
  runId?: string | null;
  harnessSlug?: string | null;
  /** Native session id — the transcript handle for an INTERACTIVE (non-bee)
   *  CLAUDE session's thinking (su/queen/sentinel). */
  sessionId?: string | null;
  /** The omp thread id — an OMP session's transcript handle
   *  (~/.omp/agent/sessions jsonl). */
  ompThreadId?: string | null;
  /** Whether this agent is ACTIVELY thinking right now (transcript appended within
   *  the last few seconds) — drives the roster's pulsing "in the middle of
   *  thinking" indicator. */
  thinking?: boolean | null;
  /** The adv_sessions row id + the OS terminal-window handle for this agent, when
   *  recorded. `windowId` (an X11 window id, resolved via wmctrl) is the ONLY
   *  reliable focus target — every gnome-terminal shares one server pid, so a pid
   *  can't be matched back to a window. Present ⇒ the "Focus window" action works;
   *  absent ⇒ it's hidden (never a dead button). */
  advSessionId?: number | null;
  windowId?: string | null;
  pid?: number | null;
}

/** Whether an agent's terminal window can be focused — i.e. we have a stored X11
 *  window id to hand `wmctrl -ia`. pid is NOT sufficient here (all gnome-terminal
 *  windows share one server pid). Pure — exported for tests. */
export function canFocusWindow(a: Pick<RosterAgent, 'windowId'>): boolean {
  return Boolean(a.windowId);
}

/** Whether an agent has a viewable thinking stream — a spawned bee's run-log, or
 *  an interactive session's transcript. Pure — exported for tests. */
export function hasThinking(a: Pick<RosterAgent, 'runId' | 'harnessSlug' | 'sessionId'>): boolean {
  return Boolean((a.runId && a.harnessSlug) || a.sessionId);
}

/** The stream URL for an agent's thinking: the bee run-log stream when it has a
 *  run, else the interactive-session transcript endpoint; null when neither. Pure.
 *  The session endpoint gets the agent's `ownerId` as a hint so the backend jumps
 *  straight to that session's isolation dir instead of sweeping all of them (the
 *  ~3s → ms fix). */
export function thinkingStreamUrl(a: Pick<RosterAgent, 'ownerId' | 'runId' | 'harnessSlug' | 'sessionId'>): string | null {
  if (a.runId && a.harnessSlug) {
    return `/api/harness/${encodeURIComponent(a.harnessSlug)}/agents/${encodeURIComponent(a.runId)}/stream?phase=staging`;
  }
  if (a.sessionId) {
    const owner = a.ownerId ? `&owner=${encodeURIComponent(a.ownerId)}` : '';
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(a.sessionId)}${owner}`;
  }
  return null;
}

/** Compact "time since" for the roster's last-active pill: 3s / 2m / 4h / 2d.
 *  Empty for a missing/invalid timestamp; a slightly-future ts (clock skew)
 *  clamps to 0s. Pure — exported for tests. */
export function fmtCompactAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** advRoster.list returns a single-element array wrapping the roster object. */
interface RosterResponse {
  active: RosterAgent[];
}

/** The colony glyph vocabulary (matches the zellij roster + AdvAgentsPanel). */
const KIND_GLYPH: Record<string, string> = {
  queen: '♛',
  overwatch: '👁',
  bee: '🐝',
  sentinel: '🛡',
  planner: '📋',
  su: '🛠',
};

/** The kind glyph for an agent — from agentPaneKind when present, else role. */
export function agentGlyph(a: Pick<RosterAgent, 'agentPaneKind' | 'role'>): string {
  const kind = (a.agentPaneKind ?? a.role ?? '').toLowerCase();
  return KIND_GLYPH[kind] ?? '·';
}

/** A short, recognizable owner id — `su-5577c5df-…` → `su-5577c`; a long bee id is
 *  truncated. Pure — exported for tests. */
export function shortOwner(id: string): string {
  const m = id.match(/^([a-z]+-[0-9a-f]{5,8})/i);
  if (m) return m[1];
  return id.length > 16 ? `${id.slice(0, 15)}…` : id;
}

/** The row's display NAME: the human owner-label, else a short owner id. NEVER the
 *  agent TYPE (claude/codex/omp) — that's the backend, not a name (it's shown as a
 *  chip in the detail instead). Pure — exported for tests. */
export function displayName(a: Pick<RosterAgent, 'label' | 'ownerId'>): string {
  const label = a.label?.trim();
  return label && label.length > 0 ? label : shortOwner(a.ownerId);
}

export interface FleetGroup {
  /** null = the "No fleet" catch-all group. */
  slug: string | null;
  color: string | null;
  agents: RosterAgent[];
}

/**
 * Group agents by fleet, fleeted groups first (alphabetical by slug), the
 * "No fleet" group last — the same ordering as the zellij roster
 * (fleet_group_sort_key). Within a group, preserve input order (the roster is
 * already newest-heartbeat first). Pure — exported for tests.
 */
export function groupByFleet(agents: readonly RosterAgent[]): FleetGroup[] {
  const byFleet = new Map<string, FleetGroup>();
  for (const a of agents) {
    const slug = a.fleetSlug && a.fleetSlug.trim() ? a.fleetSlug : null;
    const key = slug ?? ' no-fleet';
    let g = byFleet.get(key);
    if (!g) {
      g = { slug, color: slug ? a.fleetColor ?? null : null, agents: [] };
      byFleet.set(key, g);
    }
    g.agents.push(a);
  }
  return [...byFleet.values()].sort((x, y) => {
    if ((x.slug === null) !== (y.slug === null)) return x.slug === null ? 1 : -1; // No fleet last
    if (x.slug === null) return 0;
    return x.slug.localeCompare(y.slug!);
  });
}

export default function AgentsRunningPill() {
  const [open, setOpen] = useQueryState('agentsRoster', parseAsBoolean.withDefault(false));
  const { data } = useSyncQuery<RosterResponse>({
    queryName: 'advRoster.list',
    args: { workspaceId: null, endedLimit: 20 },
  });
  // A 1s clock — only while the roster is open — so the last-active pills tick up
  // live between the sync query's pushes.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);
  const active = (data?.[0]?.active ?? []) as RosterAgent[];
  // "Running" = present + not stale (a stale row is a presumed-ended session).
  const running = active.filter((a) => a.liveness !== 'stale');
  if (running.length === 0) return null;

  const groups = groupByFleet(running);
  const fleetDots = groups.filter((g) => g.slug !== null && g.color).slice(0, 6);
  const thinkingCount = running.filter((a) => a.thinking).length;

  return (
    <div className="pc-advshell__agents-pill-wrap">
      <Popover
        open={open}
        onOpenChange={(next: boolean) => void setOpen(next)}
        trigger={(
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--agents is-running"
            data-testid="agents-running-pill"
            aria-expanded={open}
            aria-controls="pc-advshell-agents-pop"
          >
            <span aria-hidden>⚡</span>
            {running.length} agent{running.length === 1 ? '' : 's'} running
            {thinkingCount > 0 && (
              <span className="pc-agents-pill__thinking" data-testid="agents-thinking-count">
                {' · '}{thinkingCount} thinking
              </span>
            )}
            {fleetDots.length > 0 && (
              <span className="pc-agents-pill__dots" aria-hidden>
                {fleetDots.map((g) => (
                  <span
                    key={g.slug}
                    className="pc-agents-pill__dot"
                    style={{ background: g.color ?? 'var(--fg-mute)' }}
                    title={g.slug ?? undefined}
                  />
                ))}
              </span>
            )}
          </button>
        )}
        tooltipLabel="Agents running — grouped by fleet"
        side="bottom"
        align="end"
        ariaLabel="Agents running"
        contentClassName="pc-advshell__agents-pop"
      >
        <div id="pc-advshell-agents-pop" data-testid="agents-running-pop">
          <AgentsRoster groups={groups} total={running.length} nowMs={nowMs} />
        </div>
      </Popover>
      <RosterStyles />
    </div>
  );
}

/** The fleet-grouped roster list rendered inside the popover. Hovering a row
 *  previews that agent's plan/work-item in the detail strip; clicking pins it. */
export function AgentsRoster({ groups, total, nowMs }: { groups: FleetGroup[]; total: number; nowMs: number }) {
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<RosterAgent | null>(null);
  const activeId = hovered ?? pinned;
  const active = useMemo(() => {
    for (const g of groups) {
      const a = g.agents.find((x) => x.ownerId === activeId);
      if (a) return { agent: a, color: g.color };
    }
    return null;
  }, [groups, activeId]);

  return (
    // onMouseLeave lives on the WHOLE roster (not just the scroll list) so moving
    // the cursor from a row DOWN into the detail pane — to reach its Live-thinking
    // button — doesn't count as "left the list" and dismiss the preview. It clears
    // only when the cursor leaves the entire roster.
    <div
      className="pc-agents-roster"
      role="group"
      aria-label={`${total} agents running`}
      data-testid="agents-roster"
      onMouseLeave={() => setHovered(null)}
    >
      <div className="pc-agents-roster__legend" aria-hidden>
        {Object.entries(KIND_GLYPH).map(([k, g]) => (
          <span key={k} className="pc-agents-roster__legend-item">{g} {k}</span>
        ))}
      </div>
      <div className="pc-agents-roster__scroll" data-testid="agents-roster-scroll">
        {groups.map((g) => (
          <section key={g.slug ?? '__none'} className="pc-agents-roster__group">
            <header
              className="pc-agents-roster__group-head"
              style={g.slug ? { color: g.color ?? undefined } : undefined}
            >
              <span className="pc-agents-roster__group-caret" aria-hidden>▾</span>
              {g.slug ?? 'No fleet'} <span className="pc-agents-roster__group-count">({g.agents.length})</span>
            </header>
            {g.agents.map((a) => (
              <div
                key={a.ownerId}
                className={`pc-agents-roster__row${a.ownerId === pinned ? ' is-pinned' : ''}`}
                data-testid={`agent-row-${a.ownerId}`}
                data-liveness={a.liveness}
                role="button"
                tabIndex={0}
                onMouseEnter={() => setHovered(a.ownerId)}
                onClick={() => {
                  // Click an agent → open its live thinking (bee run-log or the
                  // interactive session's transcript); otherwise pin its detail.
                  // Hover always previews the detail.
                  if (hasThinking(a)) setInspecting(a);
                  else setPinned((p) => (p === a.ownerId ? null : a.ownerId));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (hasThinking(a)) setInspecting(a);
                    else setPinned((p) => (p === a.ownerId ? null : a.ownerId));
                  }
                }}
              >
                <span className="pc-agents-roster__live">
                  {a.thinking ? (
                    <ThinkingDot size={7} title={`${displayName(a)} — thinking`} />
                  ) : (
                    <LivenessDot liveness={a.liveness as 'live' | 'idle' | 'stale'} size={7} title={a.liveness} />
                  )}
                  {fmtCompactAge(a.heartbeatAt, nowMs) ? (
                    <span className="pc-agents-roster__age" title={`last active ${fmtCompactAge(a.heartbeatAt, nowMs)} ago`}>
                      {fmtCompactAge(a.heartbeatAt, nowMs)}
                    </span>
                  ) : null}
                </span>
                <span className="pc-agents-roster__glyph" style={g.color ? { color: g.color } : undefined} aria-hidden>
                  {agentGlyph(a)}
                </span>
                <span className="pc-agents-roster__name" style={g.color ? { color: g.color } : undefined} title={`${a.ownerId}${a.agent ? ` · ${a.agent}` : ''}`}>
                  {displayName(a)}
                </span>
                <span className="pc-agents-roster__doing" title={a.intent || undefined}>
                  {a.feature ? <span className="pc-agents-roster__feat">{a.feature}</span> : null}
                  {a.intent || (a.currentPlanSlug ? a.currentPlanSlug : '—')}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
      {active ? (
        <AgentDetailStrip
          agent={active.agent}
          color={active.color}
          pinned={active.agent.ownerId === pinned}
          onInspect={setInspecting}
        />
      ) : null}
      {inspecting && thinkingStreamUrl(inspecting) ? (
        <AgentInspectorModal
          slug={inspecting.harnessSlug ?? ''}
          phase="staging"
          runId={inspecting.runId ?? inspecting.sessionId ?? inspecting.ownerId}
          role={inspecting.agentPaneKind ?? inspecting.role ?? 'agent'}
          streamUrl={thinkingStreamUrl(inspecting) ?? undefined}
          focusTarget={canFocusWindow(inspecting)
            ? { advSessionId: inspecting.advSessionId ?? null, windowId: inspecting.windowId ?? null, pid: inspecting.pid ?? null }
            : undefined}
          open
          onClose={() => setInspecting(null)}
        />
      ) : null}
    </div>
  );
}

/** The detail strip below the roster — the hovered/pinned agent's plan + work-item
 *  + declared intent (from the roster data). Mirrors the zellij Dossier/Plan-progress
 *  panels at a GUI glance. (Rich queued-work-items via fleet:assignments + jump-to-item
 *  navigation + live inspector are the tracked follow-up.) */
function AgentDetailStrip({
  agent,
  color,
  pinned,
  onInspect,
}: {
  agent: RosterAgent;
  color: string | null;
  pinned: boolean;
  onInspect: (a: RosterAgent) => void;
}) {
  return (
    <div className="pc-agents-roster__detail" data-testid="agent-detail">
      <div className="pc-agents-roster__detail-head" style={color ? { color } : undefined}>
        {agentGlyph(agent)} <strong>{displayName(agent)}</strong>
        {agent.fleetSlug ? <span className="pc-agents-roster__detail-fleet"> · {agent.fleetSlug}</span> : null}
        <span className="pc-agents-roster__detail-live"> · {agent.liveness}</span>
        {agent.thinking ? (
          <span className="pc-agents-roster__detail-thinking" style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 4, color: '#6aa84f' }}>
            <ThinkingDot size={6} /> thinking
          </span>
        ) : null}
        {pinned ? <span className="pc-agents-roster__detail-pin"> · pinned</span> : null}
      </div>
      <dl className="pc-agents-roster__detail-grid">
        <dt>Agent</dt><dd>{agent.agent ?? agent.role ?? '—'} · <code>{shortOwner(agent.ownerId)}</code></dd>
        <dt>Plan</dt><dd>{agent.currentPlanSlug ?? '—'}</dd>
        <dt>Work item</dt><dd>{agent.feature ?? '—'}</dd>
        <dt>Doing</dt><dd>{agent.intent || '(no declared intent)'}</dd>
      </dl>
      {/* Guarded: only an agent with a resolvable thinking source (bee run-log or
          session transcript) gets the action — no dead button otherwise. Agents
          WITHOUT one (codex/omp sessions don't record a transcript handle yet)
          get an explicit note instead of a silently-inert row, so "clicking does
          nothing" reads as a known limitation, not a broken pane. */}
      {hasThinking(agent) ? (
        <button
          type="button"
          className="pc-agents-roster__inspect"
          data-testid="agent-inspect-btn"
          onClick={() => onInspect(agent)}
        >
          ▶ Live thinking
        </button>
      ) : (
        <div className="pc-agents-roster__nothinking" data-testid="agent-no-thinking-note">
          Live thinking unavailable — this {agent.agent ?? 'session'} session has no
          recorded transcript handle{agent.agent && agent.agent !== 'claude' ? ` (${agent.agent} sessions aren't wired for transcript streaming yet)` : ''}.
        </div>
      )}
    </div>
  );
}

function RosterStyles() {
  return (
    <style>{`
      .pc-advshell__agents-pill-wrap { display: inline-flex; }
      .pc-agents-pill__thinking { color: #6aa84f; font-weight: 600; }
      .pc-agents-pill__dots { display: inline-flex; gap: 2px; margin-left: 6px; }
      .pc-agents-pill__dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
      .pc-advshell__agents-pop {
        max-height: min(70vh, 560px);
        overflow-y: auto;
        min-width: 420px;
        padding: 4px;
        /* Solid, opaque surface (design tokens) — a header popover must be readable,
           never translucent. Matches the sibling Hives popover's weight. */
        background: var(--bg-1, #0b1525);
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, var(--border, rgba(125, 211, 252, 0.26)));
        border-radius: 10px;
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
      }
      .pc-agents-roster { font-size: 12px; }
      .pc-agents-roster__legend {
        display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 8px 6px;
        font-size: 10.5px; color: var(--fg-mute); border-bottom: 1px solid var(--border);
      }
      .pc-agents-roster__group { padding: 2px 0; }
      .pc-agents-roster__group-head {
        display: flex; align-items: baseline; gap: 4px; padding: 5px 8px 2px;
        font-weight: 600; font-size: 11.5px; color: var(--fg-mute);
      }
      .pc-agents-roster__group-count { font-weight: 400; color: var(--fg-mute); font-size: 10.5px; }
      .pc-agents-roster__row {
        /* Name column HUGS its content (max-content, capped via the name's own
           max-width) so a short id like "su-5577c" doesn't reserve a wide track
           and leave a big gap before the description — the description follows
           right after. The doing column takes the rest. */
        display: grid; grid-template-columns: max-content 16px minmax(40px, max-content) minmax(0, 1fr);
        align-items: center; gap: 8px; padding: 3px 8px; border-radius: 4px;
      }
      .pc-agents-roster__row:hover { background: var(--bg-2); }
      .pc-agents-roster__row[data-liveness="stale"] { opacity: 0.5; }
      .pc-agents-roster__live { display: inline-flex; align-items: center; gap: 4px; }
      .pc-agents-roster__age {
        font-size: 9.5px; color: var(--fg-mute); font-variant-numeric: tabular-nums;
        line-height: 1; white-space: nowrap;
      }
      .pc-agents-roster__glyph { text-align: center; }
      .pc-agents-roster__name {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        max-width: 200px; /* caps the hugged name track; longer names ellipsize */
      }
      .pc-agents-roster__doing {
        color: var(--fg-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-agents-roster__feat {
        font-family: ui-monospace, monospace; font-size: 10px; margin-right: 6px;
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-agents-roster__scroll { max-height: 380px; overflow-y: auto; }
      .pc-agents-roster__row { cursor: pointer; }
      .pc-agents-roster__row.is-pinned { background: color-mix(in oklab, var(--accent), transparent 82%); }
      .pc-agents-roster__detail { border-top: 1px solid var(--border); padding: 6px 8px; background: var(--bg-2); }
      .pc-agents-roster__detail-head { font-size: 12px; margin-bottom: 4px; }
      .pc-agents-roster__detail-fleet, .pc-agents-roster__detail-live, .pc-agents-roster__detail-pin {
        color: var(--fg-mute); font-weight: 400;
      }
      .pc-agents-roster__detail-grid {
        display: grid; grid-template-columns: 68px 1fr; gap: 2px 8px; margin: 0; font-size: 11.5px;
      }
      .pc-agents-roster__detail-grid dt { color: var(--fg-mute); }
      .pc-agents-roster__detail-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-agents-roster__inspect {
        margin-top: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
        background: var(--accent, #38bdf8); color: var(--accent-ink, #051827);
        border: 1px solid var(--accent, #38bdf8); border-radius: 4px; font-weight: 600;
      }
      .pc-agents-roster__nothinking {
        margin-top: 6px; font-size: 10.5px; color: var(--fg-mute); font-style: italic;
      }
    `}</style>
  );
}
