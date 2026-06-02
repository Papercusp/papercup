'use client';

/**
 * SessionsRosterView — the live "who's active, on what" roster (plan
 * adv-sessions-live-roster-2026-06-02, P-006). Rendered as the 3rd ?view= in
 * the combined Plans/Inbox shell (P-005); the rail's plan selection arrives as
 * `planFilters` and scopes the plan-grouped section, while the No-plan and
 * presence-only groups always show (D-005).
 *
 * Data: polls GET /api/adv/roster (presence-primary + adv_sessions enrichment;
 * P-003). Liveness is server-derived per entry. The detail dossier (P-007) and
 * the files-in-play map (P-008) come later; this is the grouped rich-row list.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatRelativeUpdated } from '@/lib/format/relative-time';
import { LivenessDot, type Liveness } from '@/app/coord/presence-ui';
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
  hasLaunchRecord: boolean;
  advSessionId: number | null;
  currentPlanSlug: string | null;
  role: string | null;
  feature: string | null;
  agent: string | null;
  mode: 'omp' | 'console' | null;
  windowId: string | null;
  ompThreadId: string | null;
  cwd: string | null;
  launchStartedAt: string | null;
}

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

interface RosterResponse {
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

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

/** Poll /api/adv/roster while the tab is visible (pause when hidden). */
function useRoster(
  workspaceId: string | null | undefined,
  intervalMs = 4000,
): { data: RosterResponse | null; error: string | null; loading: boolean; refresh: () => void } {
  const url = `/api/adv/roster${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`;
  const [data, setData] = useState<RosterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData((await r.json()) as RosterResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
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

function RosterRow({ e }: { e: RosterEntry }): React.JSX.Element {
  const client = e.agent ?? shortSource(e.source);
  const extraFiles = e.currentFiles.length - 6;
  return (
    <li className="pc-roster__row" data-liveness={e.liveness}>
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
  subtitle,
  entries,
}: {
  title: string;
  subtitle?: string;
  entries: RosterEntry[];
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  const live = entries.filter((e) => e.liveness === 'live').length;
  return (
    <section className="pc-roster__group">
      <header className="pc-roster__group-head">
        <span className="pc-roster__group-title">{title}</span>
        {subtitle ? <span className="pc-roster__group-sub">{subtitle}</span> : null}
        <span className="pc-roster__group-count">{entries.length}</span>
        {live > 0 ? <span className="pc-roster__group-live">{live} live</span> : null}
      </header>
      <ul className="pc-roster__list">
        {entries.map((e) => (
          <RosterRow key={e.ownerId} e={e} />
        ))}
      </ul>
    </section>
  );
}

export default function SessionsRosterView({
  planFilters = [],
  workspaceId = null,
}: {
  planFilters?: string[];
  workspaceId?: string | null;
}): React.JSX.Element {
  const { data, error, loading } = useRoster(workspaceId);
  const active = data?.active ?? [];
  const ended = data?.ended ?? [];
  const { planGroups, noPlan, presenceOnly } = useMemo(
    () => groupRoster(active, planFilters),
    [active, planFilters],
  );

  const live = active.filter((e) => e.liveness === 'live').length;
  const idle = active.filter((e) => e.liveness === 'idle').length;
  const stale = active.filter((e) => e.liveness === 'stale').length;

  return (
    <div className="pc-roster">
      <header className="pc-roster__head">
        <span className="pc-roster__head-title">Active agents</span>
        <span className="pc-roster__head-summary">
          {active.length} total · {live} live · {idle} idle
          {stale ? ` · ${stale} stale` : ''}
        </span>
      </header>

      {error ? <div className="pc-roster__error">Couldn’t load roster: {error}</div> : null}
      {loading && active.length === 0 ? <div className="pc-roster__loading">Loading roster…</div> : null}
      {!loading && active.length === 0 && !error ? (
        <div className="pc-roster__empty">No active agents right now.</div>
      ) : null}

      {planGroups.map((g) => (
        <GroupSection key={g.slug} title={g.slug} subtitle="plan" entries={g.entries} />
      ))}
      <GroupSection title="No plan · ad-hoc SU sessions" entries={noPlan} />
      <GroupSection title="Other active agents (presence-only)" entries={presenceOnly} />

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
