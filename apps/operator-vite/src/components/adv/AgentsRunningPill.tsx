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
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Popover } from '@/app/harness/Popover';
import { Tooltip } from '@/app/harness/Tooltip';
import { LivenessDot } from '@/app/coord/presence-ui';
import AgentInspectorModal from '@/app/harness/AgentInspectorModal';
import { ThinkingDot } from '@/app/harness/AgentThinkingStream';
import { InactiveSessionsSection, SessionSearchResults, SessionsSearchInput } from './AgentsPillSessions';

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
  /** Genuine-activity timestamp (last real turn/tool dispatch, coord_presence.last_active_at)
   *  — the "since last turn" clock and the basis for activity-liveness. NOT the keepalive
   *  heartbeat. null on older/pending rows. */
  lastActiveAt?: string | null;
  /** Whether an engine loop is armed for this agent (keeps working on a cadence). */
  loopArmed?: boolean;
  /** The machine this agent runs on — this machine's fingerprint for a local agent,
   *  the announced machine_label for a federated (cross-machine, shared-hive) agent. */
  machineLabel?: string | null;
  /** True for an agent on THIS machine; false for a federated cross-machine agent. */
  isLocal?: boolean;
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
  /** Whether a transcript actually RESOLVES for this agent's live-thinking pane.
   *  Stamped by the server for interactive CLAUDE sessions: false when the recorded
   *  session_id resolves to no transcript (a parked/ended agent whose transcript is
   *  gone). Gates the "Live thinking" affordance so clicking never opens an empty
   *  pane — an unresolvable session shows the honest "unavailable" note instead
   *  (WI-2680). Absent/true for every other backend (bee / codex / omp). */
  thinkingResolvable?: boolean;
  /** The adv_sessions row id + the OS terminal-window handle for this agent, when
   *  recorded. `windowId` (an X11 window id, resolved via wmctrl) is the most
   *  direct focus target, but NOT the only one: given `advSessionId`, the
   *  /adv/sessions/focus endpoint also resolves the window from the adv row's
   *  stored windowId OR the `[adv:<id>]` window-TITLE fragment (wmctrl), so a live
   *  session whose windowId wasn't pre-resolved (common for fleet/psu launches)
   *  is still focusable. pid alone is NOT sufficient — every gnome-terminal shares
   *  one server pid, so a pid can't be matched back to a window. */
  advSessionId?: number | null;
  windowId?: string | null;
  pid?: number | null;
}

/** Whether an agent's terminal window can be focused. True when we have a stored
 *  X11 `windowId` (direct wmctrl target) OR an `advSessionId` — the
 *  /adv/sessions/focus endpoint resolves the window from the adv row / the
 *  `[adv:<id>]` title fragment in that case, so the "Focus window" affordance is
 *  offered for a live session even before its windowId is resolved (owner ask
 *  2026-07-11). A resolution miss surfaces as a graceful "focus failed", never a
 *  crash. pid alone is NOT enough (all gnome-terminals share one server pid).
 *  Pure — exported for tests. */
export function canFocusWindow(a: Pick<RosterAgent, 'windowId' | 'advSessionId'>): boolean {
  return Boolean(a.windowId) || a.advSessionId != null;
}

/** The session id to fork/resume this agent's terminal into a NEW window
 *  (WI-3882) — `<agent-cli> -r <id>` (plan-agent-launch P-023,
 *  console-launcher.ts) only accepts claude + omp session ids; codex's
 *  rollout resume is a different mechanism, so it's deliberately excluded
 *  here rather than passing an id that would silently fail. null ⇒ no
 *  Fork/Resume action shown (never a dead button). Pure — exported for tests. */
export function resumableSessionId(
  a: Pick<RosterAgent, 'agent' | 'sessionId' | 'ompThreadId'>,
): string | null {
  if (a.agent === 'codex') return null;
  return a.sessionId ?? a.ompThreadId ?? null;
}

/** Whether an agent's session can be FORKED into a new session (WI-4009;
 *  generalized 2026-07-11) — `--fork-session` (console-launcher.ts's
 *  buildConsoleEnvelope) is claude-only; omp has no fork command. Gates the
 *  Fork button for BOTH active and inactive sessions (owner ask 2026-07-11 —
 *  retracted the earlier "fork only when live" rule): forking BRANCHES a fresh
 *  session from the transcript, safe whether or not the source is still
 *  running. Resume-in-place (no fork) remains available for any non-codex
 *  backend regardless. Pure — exported for tests. */
export function canForkSession(a: Pick<RosterAgent, 'agent'>): boolean {
  return a.agent === 'claude';
}

/** Whether an agent has a viewable thinking stream — a spawned bee's run-log, a
 *  claude session's transcript, a codex session's rollout (keyed by its adv row
 *  id), or an omp session's thread jsonl. Pure — exported for tests.
 *
 *  `thinkingResolvable === false` VETOES the affordance: the server resolved the
 *  interactive claude session's transcript and found none (a parked/ended agent
 *  whose transcript is gone), so opening the pane would show an empty
 *  "waiting/stalled" state. Gating here turns that into the honest "unavailable"
 *  note instead of a misleading empty modal (WI-2680). The veto is safe — it only
 *  fires when the stream WOULD be empty; a live session's transcript file always
 *  resolves, so a working pane is never hidden. */
export function hasThinking(
  a: Pick<RosterAgent, 'runId' | 'harnessSlug' | 'sessionId' | 'agent' | 'advSessionId' | 'ompThreadId' | 'thinkingResolvable'>,
): boolean {
  if (a.thinkingResolvable === false) return false;
  return Boolean(
    (a.runId && a.harnessSlug)
    || a.sessionId
    || (a.agent === 'codex' && a.advSessionId != null)
    || a.ompThreadId,
  );
}

/** The stream URL for an agent's thinking: the bee run-log stream when it has a
 *  run, else the interactive-session transcript endpoint keyed per backend
 *  (claude sessionId · codex adv-row id · omp thread id); null when none. Pure.
 *  The claude leg gets the agent's `ownerId` as a hint so the backend jumps
 *  straight to that session's isolation dir instead of sweeping all of them (the
 *  ~3s → ms fix). */
export function thinkingStreamUrl(
  a: Pick<RosterAgent, 'ownerId' | 'runId' | 'harnessSlug' | 'sessionId' | 'agent' | 'advSessionId' | 'ompThreadId'>,
): string | null {
  if (a.runId && a.harnessSlug) {
    return `/api/harness/${encodeURIComponent(a.harnessSlug)}/agents/${encodeURIComponent(a.runId)}/stream?phase=staging`;
  }
  if (a.sessionId) {
    const owner = a.ownerId ? `&owner=${encodeURIComponent(a.ownerId)}` : '';
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(a.sessionId)}${owner}`;
  }
  if (a.agent === 'codex' && a.advSessionId != null) {
    return `/api/adv/session/thinking?codexSessionKey=${encodeURIComponent(String(a.advSessionId))}`;
  }
  if (a.ompThreadId) {
    return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(a.ompThreadId)}`;
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

/** The window that counts as "live" in this dropdown: took a turn within the last
 *  10 minutes. */
export const LIVE_TURN_MS = 600_000;

/**
 * Whether an agent is "live" for this dropdown, per the owner's definition: it took
 * a turn within the last 10 minutes (lastActiveAt — GENUINE activity, not the 60s
 * keepalive heartbeat), OR an engine loop is armed (it will keep working on a
 * cadence). This is deliberately NOT the heartbeat-based `liveness` (which is
 * keepalive-polluted and effectively means "process alive"). Pure — exported for
 * tests.
 */
export function isLiveByActivity(
  a: Pick<RosterAgent, 'lastActiveAt' | 'loopArmed'>,
  nowMs: number,
): boolean {
  if (a.loopArmed) return true;
  const iso = a.lastActiveAt ?? null;
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return nowMs - t < LIVE_TURN_MS;
}

/** Distinct machines represented in the roster — local machines by their label,
 *  a still-unlabeled local row folded under one "__local__" bucket, federated rows
 *  by their machineLabel. Used for the "across N machines" pill count. Pure. */
export function distinctMachineCount(
  agents: readonly Pick<RosterAgent, 'machineLabel' | 'isLocal'>[],
): number {
  const set = new Set<string>();
  for (const a of agents) {
    set.add(a.machineLabel ?? (a.isLocal === false ? '__remote__' : '__local__'));
  }
  return set.size;
}

/** The machine-grouping key for an agent (matches distinctMachineCount). Pure. */
export function machineKey(a: Pick<RosterAgent, 'machineLabel' | 'isLocal'>): string {
  return a.machineLabel ?? (a.isLocal === false ? '__remote__' : '__local__');
}

export interface MachineTab {
  key: string;
  label: string;
  isLocal: boolean;
  count: number;
}

/**
 * Per-machine tabs for the roster: THIS machine first (labeled "Local"), then each
 * remote machine in the shared hive, alphabetical by label. `count` = agents on that
 * machine. Empty/one-machine setups produce ≤1 tab (the caller then hides the bar).
 * Pure — exported for tests.
 */
export function machineTabs(agents: readonly RosterAgent[]): MachineTab[] {
  const byKey = new Map<string, MachineTab>();
  for (const a of agents) {
    const key = machineKey(a);
    const isLocal = a.isLocal !== false;
    const label = isLocal ? 'Local' : (a.machineLabel ?? 'Remote');
    const t = byKey.get(key) ?? { key, label, isLocal, count: 0 };
    t.count += 1;
    byKey.set(key, t);
  }
  return [...byKey.values()].sort((x, y) =>
    x.isLocal !== y.isLocal ? (x.isLocal ? -1 : 1) : x.label.localeCompare(y.label),
  );
}

/** advRoster.list returns a single-element array wrapping the roster object. */
interface RosterResponse {
  active: RosterAgent[];
}

/** The cup-cast glyph vocabulary (restore-pot-lexicon D-006) — matches the
 *  zellij roster (apps/tui agent_pane_kind.rs) + AdvAgentsPanel AGENT_KIND_GLYPH.
 *  queen=Mug 🍵 · overwatch=Kettle 🫖 · sentinel=Papercup 🥤 · bee(worker)=☕. */
const KIND_GLYPH: Record<string, string> = {
  queen: '🍵',
  overwatch: '🫖',
  bee: '☕',
  sentinel: '🥤',
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
  // Search-anything box state — URL-backed like agentsRoster/agentsMachine.
  // Plain string form (no parseAsString.withDefault): the parser object runs at
  // every pill render, and the suite-wide nuqs test mocks stub parseAsString as
  // a bare `{}` — the guard also tolerates their single-shared-value stubs.
  const [searchQRaw, setSearchQ] = useQueryState('agentsQ');
  const searchQ = typeof searchQRaw === 'string' ? searchQRaw : '';
  // Shown = present (not heartbeat-stale) OR loop-armed. A loop-armed agent keeps
  // working on a cadence even while parked between wakes, so it belongs here even if
  // its presence heartbeat has gone stale. Memoed on `data` so the identities stay
  // stable across the 1s nowMs ticks while the popover is open.
  const running = useMemo(
    () => ((data?.[0]?.active ?? []) as RosterAgent[]).filter((a) => a.liveness !== 'stale' || a.loopArmed),
    [data],
  );
  const activeOwnerIds = useMemo(() => new Set(running.map((a) => a.ownerId)), [running]);
  const q = searchQ.trim();
  if (running.length === 0) return null;

  const groups = groupByFleet(running);
  const fleetDots = groups.filter((g) => g.slug !== null && g.color).slice(0, 6);
  const thinkingCount = running.filter((a) => a.thinking).length;
  const machineCount = distinctMachineCount(running);

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
            {machineCount > 1 && (
              <span className="pc-agents-pill__machines" data-testid="agents-machine-count">
                {' across '}{machineCount} machines
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
          <SessionsSearchInput value={searchQ} onChange={(v) => void setSearchQ(v || null)} />
          {q.length >= 2 ? (
            <SessionSearchResults query={q} nowMs={nowMs} />
          ) : (
            <>
              <AgentsRoster agents={running} nowMs={nowMs} />
              <InactiveSessionsSection activeOwnerIds={activeOwnerIds} nowMs={nowMs} />
            </>
          )}
        </div>
      </Popover>
      <RosterStyles />
    </div>
  );
}

/** The fleet-grouped roster list rendered inside the popover. Hovering a row
 *  previews that agent's plan/work-item in the detail strip; clicking pins it. */
export function AgentsRoster({ agents, nowMs }: { agents: RosterAgent[]; nowMs: number }) {
  const [pinned, setPinned] = useState<string | null>(null);
  // Keep the most recently previewed agent selected after the pointer leaves the
  // roster. The detail strip sits directly above the inactive-sessions control;
  // clearing hover on mouse-leave made that whole section blink out while the
  // user moved toward it. Falling back to the first visible agent also keeps the
  // strip mounted before the first hover and across push-driven roster refreshes.
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<RosterAgent | null>(null);
  // Shared-hive per-machine tabs: THIS machine ("Local") first, then each connected
  // machine. Only shown when >1 machine is present; otherwise the whole roster renders
  // as before. The selected tab rides nuqs (?agentsMachine=); clearing it = Local.
  const [machineTab, setMachineTab] = useQueryState('agentsMachine', parseAsString);
  const tabs = useMemo(() => machineTabs(agents), [agents]);
  const showTabs = tabs.length > 1;
  const activeTabKey = showTabs
    ? (machineTab && tabs.some((t) => t.key === machineTab) ? machineTab : tabs[0].key)
    : null;
  const shown = useMemo(
    () => (activeTabKey ? agents.filter((a) => machineKey(a) === activeTabKey) : agents),
    [agents, activeTabKey],
  );
  const groups = useMemo(() => groupByFleet(shown), [shown]);
  const total = shown.length;
  // Sticky detail selection (WI-3881): the explicitly pinned/hovered agent wins,
  // then whoever we were ALREADY showing (if still present), then the first row.
  // Resolving through this fallback chain means a live-roster refresh that briefly
  // drops the selected agent — e.g. its heartbeat ages to 'stale' for one push, so
  // it is filtered out of `running` (see the `liveness !== 'stale'` filter above) —
  // no longer collapses `active` to null. That null was what made the detail strip
  // disappear and reappear on every refresh; now it stays mounted, falling through
  // to the last-shown agent (or the first row) instead of blanking.
  const lastShownIdRef = useRef<string | null>(null);
  const active = useMemo(() => {
    const findIn = (id: string | null) => {
      if (!id) return null;
      for (const g of groups) {
        const a = g.agents.find((x) => x.ownerId === id);
        if (a) return { agent: a, color: g.color };
      }
      return null;
    };
    return (
      findIn(pinned) ??
      findIn(previewed) ??
      findIn(lastShownIdRef.current) ??
      (shown[0] ? findIn(shown[0].ownerId) : null)
    );
  }, [groups, shown, pinned, previewed]);
  // Remember whoever the strip is currently showing, so the next refresh prefers
  // to keep showing them (sticky) rather than snapping back to the first row.
  useEffect(() => {
    if (active) lastShownIdRef.current = active.agent.ownerId;
  }, [active]);

  return (
    // The last preview remains selected when the pointer leaves. This keeps the
    // detail strip mounted while the user moves into it or the inactive-session
    // section below it.
    <div
      className="pc-agents-roster"
      role="group"
      aria-label={`${total} agents running`}
      data-testid="agents-roster"
    >
      {showTabs && (
        <div className="pc-agents-roster__tabs" role="tablist" data-testid="agents-machine-tabs">
          {tabs.map((t) => (
            <Tooltip
              key={t.key}
              label={t.isLocal ? 'Agents on this machine' : `Agents on ${t.label}`}
              side="bottom"
            >
              <button
                type="button"
                role="tab"
                aria-selected={t.key === activeTabKey}
                className={`pc-agents-roster__tab${t.key === activeTabKey ? ' is-active' : ''}`}
                data-testid={`agents-machine-tab-${t.key}`}
                onClick={() => void setMachineTab(t.key === tabs[0].key ? null : t.key)}
              >
                {t.label} <span className="pc-agents-roster__tab-count">{t.count}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      )}
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
                onMouseEnter={() => setPreviewed(a.ownerId)}
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
                    <LivenessDot
                      liveness={isLiveByActivity(a, nowMs) ? 'live' : 'idle'}
                      size={7}
                      title={
                        isLiveByActivity(a, nowMs)
                          ? a.loopArmed
                            ? 'live — loop armed'
                            : 'live — took a turn in the last 10m'
                          : 'idle — no turn in the last 10m'
                      }
                    />
                  )}
                  {fmtCompactAge(a.lastActiveAt ?? a.heartbeatAt, nowMs) ? (
                    <span
                      className="pc-agents-roster__age"
                      title={`last turn ${fmtCompactAge(a.lastActiveAt ?? a.heartbeatAt, nowMs)} ago`}
                    >
                      {fmtCompactAge(a.lastActiveAt ?? a.heartbeatAt, nowMs)}
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
          nowMs={nowMs}
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
          resumeTarget={resumableSessionId(inspecting)
            ? {
                sessionId: resumableSessionId(inspecting)!,
                // This roster only shows RUNNING agents, so the source is live —
                // tags the Resume button's collision-warning tooltip. Fork
                // (canFork) branches a fresh session and avoids the collision.
                live: true,
                canFork: canForkSession(inspecting),
                // No fixed label: each button self-labels (fork · / resume · role)
                // since the two actions share this resumeTarget.
              }
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
  nowMs,
  onInspect,
}: {
  agent: RosterAgent;
  color: string | null;
  pinned: boolean;
  nowMs: number;
  onInspect: (a: RosterAgent) => void;
}) {
  return (
    <div className="pc-agents-roster__detail" data-testid="agent-detail">
      <div className="pc-agents-roster__detail-head" style={color ? { color } : undefined}>
        {agentGlyph(agent)} <strong>{displayName(agent)}</strong>
        {agent.fleetSlug ? <span className="pc-agents-roster__detail-fleet"> · {agent.fleetSlug}</span> : null}
        <span className="pc-agents-roster__detail-live"> · {isLiveByActivity(agent, nowMs) ? (agent.loopArmed ? 'live (loop armed)' : 'live') : 'idle'}</span>
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
      {/* Guarded: only an agent with a resolvable thinking source (bee run-log,
          or a claude/codex/omp transcript that ACTUALLY resolves) gets the action —
          no dead button otherwise. Two "no thinking" cases get an explicit,
          accurate note instead of a silently-inert row OR an empty modal (WI-2680):
          (a) a presence-only process that never recorded a session/run/thread
          handle, and (b) a claude session WITH a handle whose transcript no longer
          resolves (parked/ended agent, transcript rotated/cleaned away) — flagged
          by thinkingResolvable===false. */}
      {hasThinking(agent) ? (
        <button
          type="button"
          className="pc-agents-roster__inspect"
          data-testid="agent-inspect-btn"
          onClick={() => onInspect(agent)}
        >
          ▶ Live thinking
        </button>
      ) : agent.thinkingResolvable === false ? (
        <div className="pc-agents-roster__nothinking" data-testid="agent-no-thinking-note">
          Live thinking unavailable — no transcript to stream (this session has ended or
          its transcript was rotated away since it last took a turn).
        </div>
      ) : (
        <div className="pc-agents-roster__nothinking" data-testid="agent-no-thinking-note">
          Live thinking unavailable — this {agent.agent ?? 'session'} process recorded no
          transcript handle (no session row, run-log, or thread id) to stream from.
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
        /* DEFINITE width, not content-driven: intrinsic max-content sizing let a
           long agent intent blow the roster popover past the viewport (~1600px),
           and typing a search query then snapped it down to the 420px min — the
           "search box goes narrow" glitch. One stable width for every state
           (roster / search results / inactive list); rows already ellipsize. */
        width: min(680px, calc(100vw - 24px));
        min-width: 420px;
        padding: 4px;
        /* Flex column so fixed chrome (search box, hover detail strip, inactive
           footer) never slides under the sticky footer — the roster LIST is the
           part that shrinks/scrolls; popover overflow stays as a safety valve. */
        display: flex; flex-direction: column;
        /* Solid, opaque surface (design tokens) — a header popover must be readable,
           never translucent. Matches the sibling Hives popover's weight. */
        background: var(--bg-1, #0b1525);
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, var(--border, rgba(125, 211, 252, 0.26)));
        border-radius: 10px;
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
      }
      #pc-advshell-agents-pop { display: flex; flex-direction: column; min-height: 0; }
      .pc-agents-roster { font-size: 12px; display: flex; flex-direction: column; min-height: 0; }
      .pc-agents-roster__tabs { display: flex; gap: 2px; padding: 4px 6px 0; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
      .pc-agents-roster__tab {
        font-size: 11px; padding: 3px 9px; border-radius: 6px 6px 0 0; cursor: pointer;
        background: transparent; color: var(--fg-mute); border: 1px solid transparent; border-bottom: none;
      }
      .pc-agents-roster__tab:hover { background: var(--bg-2); }
      .pc-agents-roster__tab.is-active { background: var(--bg-2); color: var(--fg); border-color: var(--border); }
      .pc-agents-roster__tab-count { color: var(--fg-mute); font-variant-numeric: tabular-nums; margin-left: 2px; }
      .pc-agents-pill__machines { color: var(--fg-mute); }
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
      .pc-agents-roster__scroll { max-height: 380px; overflow-y: auto; flex: 0 1 auto; min-height: 60px; }
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
