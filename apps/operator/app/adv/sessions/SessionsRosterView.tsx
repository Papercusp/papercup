'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * SessionsRosterView — the live "who's active, on what" roster (plan
 * adv-sessions-live-roster-2026-06-02, P-006). Rendered as the 3rd ?view= in
 * the combined Plans/Inbox shell (P-005); the rail's plan selection arrives as
 * `planFilters` and scopes the plan-grouped section, while the No-plan and
 * presence-only groups always show (D-005).
 *
 * Data: advRoster.list sync query (presence-primary + adv_sessions enrichment;
 * P-003). Liveness is server-derived per entry. The detail dossier (P-007) and
 * the files-in-play map (P-008) share the same provider-backed roster snapshot.
 */

import { useCallback, useMemo } from 'react';
import { formatRelativeUpdated } from '@papercusp/operator-core/lib/format/relative-time';
import { LivenessDot, type Liveness } from '@/app/coord/presence-ui';
import { Select } from '@/app/harness/Select';
import AgentDossier from './AgentDossier';
import { useRosterData } from './SessionsRosterContext';
import './SessionsRosterView.css';

/**
 * Mirrors the server RosterEntry (apps/operator/lib/adv-roster.ts). Inlined,
 * NOT imported, so this client component never pulls the server module — that
 * would drag PG/node builtins into the SPA bundle (the operator-vite blank-page
 * failure mode). The endpoint JSON is the contract.
 */
export interface RosterEntry {
  ownerId: string;
  label: string;
  source: string;
  intent: string;
  currentFiles: string[];
  host: string;
  pid: number | null;
  startedAt: string;
  heartbeatAt: string;
  liveness: Liveness;
  stale: boolean;
  workspaceId: string;
  userId: string | null;
  revoked: boolean;
  /** OS process alive? null = unknown. Non-stale + false = zombie (P-008). */
  pidAlive: boolean | null;
  hasLaunchRecord: boolean;
  advSessionId: number | null;
  currentPlanSlug: string | null;
  role: string | null;
  feature: string | null;
  agent: string | null;
  mode: 'omp' | 'console' | null;
  windowId: string | null;
  ompThreadId: string | null;
  sessionId?: string | null;
  nativeSession?: NativeSessionHandle | null;
  cwd: string | null;
  launchStartedAt: string | null;
}

export type NativeSessionHandle =
  | {
      backend: 'claude';
      source: 'adv_sessions' | 'spawned_agents';
      ownerId: string | null;
      sessionId: string | null;
      exactResumeSupported: boolean;
      missingReason: string | null;
    }
  | {
      backend: 'codex';
      source: 'adv_sessions' | 'spawned_agents';
      ownerId: string | null;
      codexHome: string;
      rolloutId: string | null;
      exactResumeSupported: boolean;
      missingReason: string | null;
    }
  | {
      backend: 'omp';
      source: 'adv_sessions' | 'spawned_agents';
      ownerId: string | null;
      ompThreadId: string | null;
      agentHome: string | null;
      exactResumeSupported: boolean;
      missingReason: string | null;
    };

/** The relevant fields of an ended adv_sessions row (AdvSessionRow subset). */
export interface EndedRow {
  id: number;
  label: string | null;
  role: string | null;
  feature: string | null;
  agent: string | null;
  planSlug: string | null;
  endedAt: string | null;
}

export interface RosterResponse {
  active: RosterEntry[];
  ended: EndedRow[];
}

function shortSource(s: string): string {
  const v = (s || '').toLowerCase();
  if (v.includes('claude')) return 'claude';
  if (v.includes('codex')) return 'codex';
  if (v.includes('omp')) return 'omp';
  return s || '—';
}

/** Facet filters for the roster (P-010). Each null/'' = unset (no constraint). */
export interface RosterFilters {
  /** client/source: claude · codex · omp */
  client: string | null;
  liveness: Liveness | null;
  role: string | null;
  /** substring match against an agent's current files ("who's editing X"). */
  file: string;
}

export const EMPTY_FILTERS: RosterFilters = {
  client: null,
  liveness: null,
  role: null,
  file: '',
};

/** Stable empty default for the optional plan-title lookup — avoids a fresh
 *  Map identity on every render when the prop is omitted. */
const EMPTY_PLAN_TITLES: ReadonlyMap<string, string> = new Map();

/**
 * Fallback plan-group header when a plan has no human title: strip the
 * trailing `-YYYY-MM-DD` date suffix so the raw slug reads a little better.
 * Mirrors AdvPlansTabs' labelForPlan fallback.
 */
function planSlugFallback(slug: string): string {
  return slug.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

export function hasActiveFilters(f: RosterFilters): boolean {
  return !!(f.client || f.liveness || f.role || f.file.trim());
}

/**
 * Apply the facet filters to the active roster (P-010). Unlike the plan rail
 * (D-005, which never hides no-plan/presence-only groups), these are EXPLICIT
 * user filters and apply uniformly to every agent. Pure → unit-tested.
 */
export function applyRosterFilters(active: RosterEntry[], f: RosterFilters): RosterEntry[] {
  const fileQ = f.file.trim().toLowerCase();
  return active.filter((e) => {
    if (f.client && (e.agent ?? shortSource(e.source)) !== f.client) return false;
    if (f.liveness && e.liveness !== f.liveness) return false;
    if (f.role && (e.role ?? '') !== f.role) return false;
    if (fileQ && !e.currentFiles.some((p) => p.toLowerCase().includes(fileQ))) return false;
    return true;
  });
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

interface Grouped {
  planGroups: Array<{ slug: string; entries: RosterEntry[] }>;
  noPlan: RosterEntry[];
  presenceOnly: RosterEntry[];
}

/**
 * Split the active roster into plan groups + the two always-shown groups.
 * `planFilters` (the rail selection) narrows the plan groups only; the No-plan
 * and presence-only groups are never hidden by it (D-005).
 */
export function groupRoster(active: RosterEntry[], planFilters: string[]): Grouped {
  const byPlan = new Map<string, RosterEntry[]>();
  const noPlan: RosterEntry[] = [];
  const presenceOnly: RosterEntry[] = [];
  for (const e of active) {
    if (e.currentPlanSlug) {
      const arr = byPlan.get(e.currentPlanSlug) ?? [];
      arr.push(e);
      byPlan.set(e.currentPlanSlug, arr);
    } else if (e.hasLaunchRecord) {
      noPlan.push(e);
    } else {
      presenceOnly.push(e);
    }
  }
  const filterSet = new Set(planFilters);
  const planGroups = [...byPlan.entries()]
    .filter(([slug]) => filterSet.size === 0 || filterSet.has(slug))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slug, entries]) => ({ slug, entries }));
  return { planGroups, noPlan, presenceOnly };
}

/**
 * A "zombie" agent: its heartbeat says it's still around (not stale) but the OS
 * process is confirmed dead (P-008). pidAlive===null is "unknown", NOT a zombie.
 */
export function isZombie(e: { liveness: Liveness; pidAlive: boolean | null }): boolean {
  return e.liveness !== 'stale' && e.pidAlive === false;
}

export interface FileInPlay {
  path: string;
  agents: RosterEntry[];
  /** 2+ agents declaring the same file — a contention hotspot. */
  contended: boolean;
}

/**
 * Invert the roster: file → the agents declaring it as a current file (P-008).
 * Contended files (2+ agents) sort first, then by agent count desc, then path.
 * An agent's own duplicate file entries are de-duped per agent.
 */
export function buildFilesInPlay(active: RosterEntry[]): FileInPlay[] {
  const byFile = new Map<string, Map<string, RosterEntry>>();
  for (const e of active) {
    for (const f of new Set(e.currentFiles)) {
      const agents = byFile.get(f) ?? new Map<string, RosterEntry>();
      agents.set(e.ownerId, e);
      byFile.set(f, agents);
    }
  }
  return [...byFile.entries()]
    .map(([path, agents]) => ({
      path,
      agents: [...agents.values()],
      contended: agents.size >= 2,
    }))
    .sort(
      (a, b) =>
        Number(b.contended) - Number(a.contended) ||
        b.agents.length - a.agents.length ||
        a.path.localeCompare(b.path),
    );
}

function RosterRow({
  e,
  selected,
  onSelect,
}: {
  e: RosterEntry;
  selected: boolean;
  onSelect: (ownerId: string) => void;
}): React.JSX.Element {
  const client = e.agent ?? shortSource(e.source);
  const extraFiles = e.currentFiles.length - 6;
  return (
    <li
      className="pc-roster__row"
      data-liveness={e.liveness}
      data-selected={selected || undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(e.ownerId)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onSelect(e.ownerId);
        }
      }}
    >
      <div className="pc-roster__row-main">
        <LivenessDot liveness={e.liveness} />
        <span className="pc-roster__badge" data-client={client}>
          {client}
        </span>
        {e.role ? <span className="pc-roster__chip">{e.role}</span> : null}
        {e.feature ? (
          <span className="pc-roster__chip pc-roster__chip--feature">{e.feature}</span>
        ) : null}
        <span className="pc-roster__label" title={e.ownerId}>
          {e.label || e.ownerId.slice(0, 14)}
        </span>
        {e.revoked ? (
          <span className="pc-roster__chip pc-roster__chip--warn" title="session token revoked">
            revoked
          </span>
        ) : null}
        {isZombie(e) ? (
          <span
            className="pc-roster__chip pc-roster__chip--warn"
            title="zombie: fresh heartbeat but the OS process is gone"
          >
            zombie
          </span>
        ) : null}
        <span className="pc-roster__age" title={new Date(e.heartbeatAt).toLocaleString()}>
          {formatRelativeUpdated(e.heartbeatAt)}
        </span>
      </div>
      <div className="pc-roster__intent">{e.intent || '(no declared intent)'}</div>
      {e.currentFiles.length > 0 || e.host || e.pid != null ? (
        <div className="pc-roster__files">
          {e.currentFiles.slice(0, 6).map((f) => (
            <span key={f} className="pc-roster__file-chip" title={f}>
              {basename(f)}
            </span>
          ))}
          {extraFiles > 0 ? <span className="pc-roster__file-chip">+{extraFiles}</span> : null}
          {e.host || e.pid != null ? (
            <span className="pc-roster__meta">
              {e.host}
              {e.pid != null ? `·${e.pid}` : ''}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function GroupSection({
  title,
  entries,
  selectedAgent,
  onSelect,
}: {
  title: string;
  entries: RosterEntry[];
  selectedAgent: string | null;
  onSelect: (ownerId: string) => void;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  const live = entries.filter((e) => e.liveness === 'live').length;
  return (
    <section className="pc-roster__group">
      <header className="pc-roster__group-head">
        <span className="pc-roster__group-title">{title}</span>
        <span className="pc-roster__group-count">{entries.length}</span>
        {live > 0 ? <span className="pc-roster__group-live">{live} live</span> : null}
      </header>
      <ul className="pc-roster__list">
        {entries.map((e) => (
          <RosterRow
            key={e.ownerId}
            e={e}
            selected={e.ownerId === selectedAgent}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Roster facet filters (P-010): client / liveness / role dropdowns + a
 * "who's editing <file>" substring box. Each change emits the full next
 * RosterFilters so the parent shell persists it to the URL (nuqs).
 */
// Sentinels for the "no constraint" option — the harness <Select> drops
// empty-value options, so null filters map to these instead of ''.
const ALL = '_all';
const ANY = '_any';

function FilterBar({
  filters,
  roleOptions,
  onChange,
}: {
  filters: RosterFilters;
  roleOptions: string[];
  onChange: (next: RosterFilters) => void;
}): React.JSX.Element {
  const active = hasActiveFilters(filters);
  return (
    <div className="pc-roster__filters">
      <Select
        ariaLabel="Filter by client"
        value={filters.client ?? ALL}
        onChange={(v) => onChange({ ...filters, client: v === ALL ? null : v })}
        options={[
          { value: ALL, label: 'all clients' },
          { value: 'claude', label: 'claude' },
          { value: 'codex', label: 'codex' },
          { value: 'omp', label: 'omp' },
        ]}
      />
      <Select
        ariaLabel="Filter by liveness"
        value={filters.liveness ?? ANY}
        onChange={(v) =>
          onChange({ ...filters, liveness: v === ANY ? null : (v as Liveness) })
        }
        options={[
          { value: ANY, label: 'any liveness' },
          { value: 'live', label: 'live' },
          { value: 'idle', label: 'idle' },
          { value: 'stale', label: 'stale' },
        ]}
      />
      <Select
        ariaLabel="Filter by role"
        value={filters.role ?? ANY}
        onChange={(v) => onChange({ ...filters, role: v === ANY ? null : v })}
        disabled={roleOptions.length === 0}
        options={[
          { value: ANY, label: 'any role' },
          ...roleOptions.map((r) => ({ value: r, label: r })),
        ]}
      />
      <input
        className="pc-roster__filter-file"
        type="search"
        aria-label="Who's editing file"
        placeholder="who's editing file…"
        value={filters.file}
        onChange={(e) => onChange({ ...filters, file: e.target.value })}
      />
      {active ? (
        <Tooltip label="Clear all filters"><button
          type="button"
          className="pc-roster__filter-clear"
          onClick={() => onChange(EMPTY_FILTERS)}

        >
          clear
        </button></Tooltip>
      ) : null}
    </div>
  );
}

/**
 * Files-in-play inverse map (P-008): each declared file → the agents on it,
 * contended files (2+) headlined. Agent chips select the agent's dossier.
 */
function FilesInPlaySection({
  files,
  selectedAgent,
  onSelect,
}: {
  files: FileInPlay[];
  selectedAgent: string | null;
  onSelect: (ownerId: string) => void;
}): React.JSX.Element | null {
  if (files.length === 0) return null;
  const contended = files.filter((f) => f.contended).length;
  return (
    <section className="pc-roster__group pc-files">
      <header className="pc-roster__group-head">
        <span className="pc-roster__group-title">Files in play</span>
        <span className="pc-roster__group-count">{files.length}</span>
        {contended > 0 ? (
          <span className="pc-files__contend" title="files with 2+ agents declaring them">
            {contended} contended
          </span>
        ) : null}
      </header>
      <ul className="pc-files__list">
        {files.map((f) => (
          <li key={f.path} className="pc-files__row" data-contended={f.contended || undefined}>
            <span className="pc-files__path" title={f.path}>
              {basename(f.path)}
            </span>
            <span className="pc-files__agents">
              {f.agents.map((a) => {
                const client = a.agent ?? shortSource(a.source);
                return (
                  <Tooltip key={a.ownerId} label={`${client} · ${a.label || a.ownerId}${isZombie(a) ? ' · zombie' : ''}`}><button

                    type="button"
                    className="pc-files__agent"
                    data-selected={a.ownerId === selectedAgent || undefined}
                    data-liveness={a.liveness}

                    onClick={() => onSelect(a.ownerId)}
                  >
                    <LivenessDot liveness={a.liveness} size={6} />
                    {client}
                    {isZombie(a) ? <span className="pc-files__zombie">!</span> : null}
                  </button></Tooltip>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * SessionsRosterList — the left LIST slot of the Sessions 2-pane: the grouped
 * rich-row roster + filters + files-in-play + ended section. Reads the shared
 * roster poll via `useRosterData()`; the dossier slot reads the same poll.
 */
export function SessionsRosterList({
  planFilters = [],
  selectedAgent = null,
  onSelectAgent,
  filters = EMPTY_FILTERS,
  onFilterChange,
  planTitleBySlug = EMPTY_PLAN_TITLES,
  showStale = false,
  onToggleStale,
}: {
  planFilters?: string[];
  /** Owner id of the agent whose dossier is open (P-007); null = none. */
  selectedAgent?: string | null;
  /** Open/close the dossier. Owned by the parent shell's nuqs ?agent= param. */
  onSelectAgent?: (ownerId: string | null) => void;
  /** Facet filters (P-010), owned by the parent shell's nuqs params. */
  filters?: RosterFilters;
  onFilterChange?: (next: RosterFilters) => void;
  /** plan-slug → human title, from the parent's plan list. Used to head each
   *  plan group with the plan's title instead of its raw slug; falls back to
   *  the (date-stripped) slug for plans absent from the map. */
  planTitleBySlug?: ReadonlyMap<string, string>;
  /** Include stale agents (heartbeat >10m) in the rendered roster. Default off:
   *  stale ≈ ended, and on a busy box they're the bulk of the rows — rendering
   *  them all is what made the roster slow to load. Owned by ?sStale=. */
  showStale?: boolean;
  onToggleStale?: () => void;
}): React.JSX.Element {
  const { data, error, loading } = useRosterData();
  const rawActive: RosterEntry[] = data?.active ?? [];
  const ended: EndedRow[] = data?.ended ?? [];

  // Role options come from the UNfiltered roster so picking a role never empties
  // its own dropdown.
  const roleOptions = useMemo(
    () => [...new Set(rawActive.map((e) => e.role).filter((r): r is string => !!r))].sort(),
    [rawActive],
  );
  const active = useMemo(() => applyRosterFilters(rawActive, filters), [rawActive, filters]);

  const live = active.filter((e) => e.liveness === 'live').length;
  const idle = active.filter((e) => e.liveness === 'idle').length;
  const staleCount = active.filter((e) => e.liveness === 'stale').length;
  const filtered = hasActiveFilters(filters);

  // PERF: stale agents are ~almost-always-ended sessions and on a busy box make
  // up the overwhelming majority of rows — rendering all of them (and their
  // files-in-play) is what made the roster take seconds to paint. Hide them by
  // default; show when the toggle is on OR the user explicitly filters to stale.
  const showStaleRows = showStale || filters.liveness === 'stale';
  const visibleActive = useMemo(
    () => (showStaleRows ? active : active.filter((e) => e.liveness !== 'stale')),
    [active, showStaleRows],
  );

  const { planGroups, noPlan, presenceOnly } = useMemo(
    () => groupRoster(visibleActive, planFilters),
    [visibleActive, planFilters],
  );
  const filesInPlay = useMemo(() => buildFilesInPlay(visibleActive), [visibleActive]);

  const select = useCallback(
    (ownerId: string) => {
      // Toggle: clicking the open agent closes the pane.
      onSelectAgent?.(ownerId === selectedAgent ? null : ownerId);
    },
    [onSelectAgent, selectedAgent],
  );
  return (
    <div className="pc-roster">
      <div className="pc-roster__sticky">
          <header className="pc-roster__head">
            <span className="pc-roster__head-title">Active agents</span>
            <span
              className="pc-roster__head-summary"
              title="idle = no tool call in the last minute (may be mid-reasoning), not gone"
            >
              <span className="pc-roster__count pc-roster__count--shown">
                <b>
                  {visibleActive.length}
                  {filtered ? ` / ${rawActive.length}` : ''}
                </b>{' '}
                shown
              </span>
              <span className="pc-roster__count pc-roster__count--live">{live} live</span>
              <span className="pc-roster__count pc-roster__count--idle">{idle} idle</span>
            </span>
            {staleCount > 0 && filters.liveness !== 'stale' ? (
              <Tooltip label={showStale
                    ? 'Hide stale (>10m idle) sessions'
                    : 'Show stale (>10m idle) sessions — hidden by default to keep the roster fast'}><button
                type="button"
                className="pc-roster__stale-toggle"
                aria-pressed={showStale}
                onClick={() => onToggleStale?.()}

              >
                {showStale ? 'hide' : 'show'} {staleCount} stale
              </button></Tooltip>
            ) : null}
          </header>

          <FilterBar
            filters={filters}
            roleOptions={roleOptions}
            onChange={(next) => onFilterChange?.(next)}
          />
        </div>

        {error ? <div className="pc-roster__error">Couldn’t load roster: {error}</div> : null}
        {loading && rawActive.length === 0 ? <div className="pc-roster__loading">Loading roster…</div> : null}
        {!loading && rawActive.length === 0 && !error ? (
          <div className="pc-roster__empty">No active agents right now.</div>
        ) : null}
        {!loading && rawActive.length > 0 && active.length === 0 ? (
          <div className="pc-roster__empty">No agents match the current filters.</div>
        ) : null}

        {planGroups.map((g) => (
          // Head each plan group with the plan's human title only — the slug
          // subtitle was redundant (the title is enough).
          <GroupSection
            key={g.slug}
            title={planTitleBySlug.get(g.slug) ?? planSlugFallback(g.slug)}
            entries={g.entries}
            selectedAgent={selectedAgent}
            onSelect={select}
          />
        ))}
        <GroupSection
          title="No plan · ad-hoc SU sessions"
          entries={noPlan}
          selectedAgent={selectedAgent}
          onSelect={select}
        />
        <GroupSection
          title="Other active agents (presence-only)"
          entries={presenceOnly}
          selectedAgent={selectedAgent}
          onSelect={select}
        />

        <FilesInPlaySection files={filesInPlay} selectedAgent={selectedAgent} onSelect={select} />

        {ended.length > 0 ? (
          <section className="pc-roster__ended">
            <header className="pc-roster__group-head">
              <span className="pc-roster__group-title">Recently ended</span>
              <span className="pc-roster__group-count">{ended.length}</span>
            </header>
            <ul className="pc-roster__list">
              {ended.slice(0, 12).map((r) => (
                <li key={r.id} className="pc-roster__row pc-roster__row--ended">
                  <div className="pc-roster__row-main">
                    <span className="pc-roster__badge" data-client={r.agent ?? ''}>
                      {shortSource(r.agent ?? '')}
                    </span>
                    {r.role ? <span className="pc-roster__chip">{r.role}</span> : null}
                    {r.feature ? (
                      <span className="pc-roster__chip pc-roster__chip--feature">{r.feature}</span>
                    ) : null}
                    <span className="pc-roster__label">{r.label || `#${r.id}`}</span>
                    <span className="pc-roster__age">ended {formatRelativeUpdated(r.endedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
  );
}

/**
 * SessionsRosterDetail — the right DETAIL slot of the Sessions 2-pane: the
 * dossier for the selected agent, or the persistent empty placeholder. Reads
 * the same shared roster poll (`useRosterData`) to resolve the selected entry's
 * Tier-1/2 fields. The entry is taken from the UNfiltered roster so a filter
 * change can't blank out an already-open dossier.
 */
export function SessionsRosterDetail({
  selectedAgent = null,
  onSelectAgent,
}: {
  selectedAgent?: string | null;
  onSelectAgent?: (ownerId: string | null) => void;
}): React.JSX.Element {
  const { data } = useRosterData();
  const rawActive: RosterEntry[] = data?.active ?? [];
  const selectedEntry = selectedAgent
    ? rawActive.find((e) => e.ownerId === selectedAgent) ?? null
    : null;

  return selectedAgent ? (
    <AgentDossier
      ownerId={selectedAgent}
      entry={selectedEntry}
      onClose={() => onSelectAgent?.(null)}
    />
  ) : (
    <aside className="pc-dossier pc-dossier--empty" aria-label="Agent detail">
      <div className="pc-dossier__placeholder">
        <span className="pc-dossier__placeholder-title">No agent selected</span>
        <span className="pc-dossier__placeholder-hint">
          Pick an agent from the roster — or a file’s agent chip below — to see its
          live detail: declared intent, files in play, locks held &amp; waiting, and
          recent coordination (messages, handoffs, escalations).
        </span>
      </div>
    </aside>
  );
}
