import { useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { ArrowRight, ListChecks, Users, Bell, Activity as ActivityIcon } from 'lucide-react';
import {
  usePlanList,
  usePlanAttention,
  type PlanListRow,
  type AttentionItem,
  type AttentionTier,
  type ItemStatus,
} from '@/app/admin/plans/plans-api';

/**
 * Brief 23 — the Overview / dashboard: the default landing surface of /adv.
 *
 * Composition only (see plan overview-dashboard-2026-06-05, D-003): this owns
 * the tiles + layout; it CONSUMES peers' surfaces:
 *   - top-bar rate/usage/max control  → Brief 20 `<FleetRateControl>` (stubbed
 *     here until it exports; the slots are final so the swap is a one-liner).
 *   - NEEDS-YOU tiered inbox           → Brief 21 (we read `needsHuman` off the
 *     attention feed, which Brief 21 is fixing AT THE SOURCE — so this tile
 *     auto-sharpens when their fix lands; no re-derivation here).
 *   - operator strip                   → Brief 24 desktop docked pane (placeholder
 *     strip until their dock lands; P-013).
 *
 * Tiles read GROUND-TRUTH PG state (plans list, attention, roster, activity) —
 * NOT the operator's `<report>` (D-002) — so they're correct even when the
 * operator is idle. Each tile clicks through to its full tab (D-007).
 */

// ── roster (GET /api/adv/roster → { active, ended }) — camelCase per
//    packages/operator-core/lib/adv-roster.ts RosterEntry ──────────────────
export interface OverviewRosterEntry {
  ownerId: string;
  label: string;
  intent: string;
  currentFiles: string[];
  liveness: 'live' | 'idle' | 'stale' | string;
  currentPlanSlug: string | null;
  role: string | null;
  agent: string | null;
}

// ── activity (POST /api/agent-tools/activity/recent → { rows | result }) ──
export interface OverviewActivityRow {
  id: string;
  agent: string | null;
  harness_slug: string | null;
  kind: string; // tool | lifecycle | todos
  tool_name: string | null;
  summary: string | null;
  status: string | null;
  created_at: string;
}

const TILE_LIMIT = 6;
const ACTIVITY_LIMIT = 12;

/**
 * Tile → AdvShell tab the tile clicks through to (D-007). Exported so the
 * mapping is unit-tested without mounting. Where no dedicated global tab exists
 * yet (agents/activity), we fall back to the nearest surface ('harnesses').
 */
export const OVERVIEW_TILE_TARGETS = {
  plans: 'plans',
  needsYou: 'plans',
  agents: 'harnesses',
  activity: 'harnesses',
} as const;

/** done / (todo+wip+blocked+needs-human+done) — dropped/unknown excluded. */
export function planProgress(
  counts: PlanListRow['itemCounts'],
): { done: number; total: number; pct: number } {
  if (!counts) return { done: 0, total: 0, pct: 0 };
  const get = (k: ItemStatus | 'unknown') => counts[k] ?? 0;
  const done = get('done');
  const total = get('todo') + get('wip') + get('blocked') + get('needs-human') + done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, pct };
}

/** Non-shipped plans, in-flight first, then most-recently-updated. Pure. */
export function selectActivePlans(rows: readonly PlanListRow[], limit = TILE_LIMIT): PlanListRow[] {
  const rank = (p: PlanListRow) =>
    p.startStatus === 'started' ? 0 : p.status === 'active' ? 1 : p.status === 'ready' ? 2 : 3;
  return rows
    .filter((p) => p.status !== 'shipped' && p.status !== 'superseded' && !p.archived)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (b.updated ?? '').localeCompare(a.updated ?? ''))
    .slice(0, limit);
}

/**
 * NEEDS-YOU = the Decisions tier (Brief 21's canonical `tier` field,
 * inbox-tiering-and-message-agent D-002/D-006). Runtime fallback to
 * `needsHuman`: until the release-gate deploy carries Brief 21 to the green
 * :3070 host, attention rows arrive WITHOUT `tier` (the type says required;
 * the wire may lag) — needsHuman is the pre-tier equivalent. Pure.
 */
export function selectDecisions(items: readonly AttentionItem[], limit = TILE_LIMIT): AttentionItem[] {
  return items
    .filter((i) => {
      const tier = (i as { tier?: AttentionTier }).tier;
      return tier ? tier === 'decision' : i.needsHuman;
    })
    .slice(0, limit);
}

/** Alerts tier for the top-bar badge (same wire-lag fallback as decisions). Pure. */
export function countAlerts(items: readonly AttentionItem[]): number {
  return items.filter((i) => {
    const tier = (i as { tier?: AttentionTier }).tier;
    return tier
      ? tier === 'alert'
      : !i.needsHuman && (i.kind === 'smoke-fail' || i.kind === 'coord-escalation');
  }).length;
}

/** Live (non-stale) agents, top-N. Pure. */
export function selectLiveAgents(
  roster: readonly OverviewRosterEntry[],
  limit = TILE_LIMIT,
): OverviewRosterEntry[] {
  return roster.filter((a) => a.liveness !== 'stale').slice(0, limit);
}

export default function AdvOverviewTab() {
  // Writers only (parseAsString) — AdvShell owns the canonical enum parser, so
  // writing a plain string round-trips identically. Mirrors AdvNowRunning.
  const [, setActiveTab] = useQueryState('tab', parseAsString);
  // Deep-link the inbox tier bar (Brief 21, ?inboxTier=) when a tile targets
  // the inbox. SEQUENTIAL awaits — the custom nuqs adapter merges each write
  // over the live search, so same-tick writes collide (see AdvShell).
  const [, setInboxTier] = useQueryState('inboxTier', parseAsString);
  const openInbox = async (tier: AttentionTier) => {
    await setActiveTab(OVERVIEW_TILE_TARGETS.needsYou);
    await setInboxTier(tier);
  };

  const plansQ = usePlanList({ includeArchived: false, includeLegacy: false });
  const attentionQ = usePlanAttention();

  // Roster (live fleet) — one-shot + light interval; no global sync hook yet.
  const [roster, setRoster] = useState<OverviewRosterEntry[]>([]);
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  // Activity (recent fleet stream) — same.
  const [activity, setActivity] = useState<OverviewActivityRow[]>([]);
  const [activityErr, setActivityErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const pull = () => {
      fetch('/api/adv/roster', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          if (cancel) return;
          setRoster(Array.isArray(d?.active) ? d.active : []);
          setRosterErr(null);
        })
        .catch((e) => !cancel && setRosterErr(String(e?.message ?? e)));
      fetch('/api/agent-tools/activity/recent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ limit: ACTIVITY_LIMIT }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          if (cancel) return;
          // tool result envelope varies (rows | result | the array itself) —
          // accept whichever the dispatcher returns.
          const rows: OverviewActivityRow[] = Array.isArray(d?.rows)
            ? d.rows
            : Array.isArray(d?.result)
              ? d.result
              : Array.isArray(d)
                ? d
                : [];
          setActivity(rows);
          setActivityErr(null);
        })
        .catch((e) => !cancel && setActivityErr(String(e?.message ?? e)));
    };
    pull();
    const t = setInterval(pull, 8000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, []);

  // ── derive tile data (pure helpers, exported + unit-tested) ────────────
  const plans = useMemo(() => selectActivePlans(plansQ.data?.plans ?? []), [plansQ.data]);
  const attentionItems = useMemo(
    () => (attentionQ.data?.groups ?? []).flatMap((g) => g.items ?? []),
    [attentionQ.data],
  );
  const decisions = useMemo(() => selectDecisions(attentionItems), [attentionItems]);
  const alertCount = useMemo(() => countAlerts(attentionItems), [attentionItems]);
  const liveAgents = useMemo(() => selectLiveAgents(roster), [roster]);
  const recentActivity = useMemo(() => activity.slice(0, 10), [activity]);

  return (
    <div className="pc-overview">
      {/* ── Top bar: Brief 20 rate/usage/max control (stub) + alerts ──── */}
      <div className="pc-overview__topbar">
        <FleetRateControlStub />
        <div className="pc-overview__topbar-spacer" />
        <button
          type="button"
          className="pc-overview__alerts"
          data-has-alerts={alertCount > 0}
          title="Alerts — smoke failures + escalations"
          onClick={() => void openInbox('alert')}
        >
          <Bell size={13} aria-hidden />
          <span>{alertCount}</span>
        </button>
      </div>

      {/* ── 2×2 tiles ──────────────────────────────────────────────────── */}
      <div className="pc-overview__grid">
        <OverviewTile
          icon={<ListChecks size={14} aria-hidden />}
          title="Plans"
          count={plansQ.data?.plans?.filter((p) => p.status === 'active' || p.startStatus === 'started').length}
          loading={plansQ.loading && !plansQ.data}
          error={plansQ.error}
          empty={plans.length === 0}
          emptyLabel="No active plans"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.plans)}
        >
          {plans.map((p) => {
            const { done, total, pct } = planProgress(p.itemCounts);
            return (
              <div key={p.slug} className="pc-overview__plan">
                <div className="pc-overview__plan-head">
                  <span className="pc-overview__plan-title" title={p.title ?? p.slug}>
                    {p.title ?? p.slug}
                  </span>
                  <span className="pc-overview__plan-frac">
                    {done}/{total}
                  </span>
                </div>
                <div className="pc-overview__bar" aria-hidden>
                  <div className="pc-overview__bar-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </OverviewTile>

        <OverviewTile
          icon={<Bell size={14} aria-hidden />}
          title="Needs you"
          count={decisions.length}
          accent="#f59e0b"
          loading={attentionQ.loading && !attentionQ.data}
          error={attentionQ.error}
          empty={decisions.length === 0}
          emptyLabel="Nothing needs you right now"
          onOpen={() => void openInbox('decision')}
        >
          {decisions.map((d) => (
            <div key={d.id} className="pc-overview__row">
              <span className="pc-overview__row-dot" data-imp={d.importance} aria-hidden />
              <span className="pc-overview__row-title" title={d.body || d.title}>
                {d.title}
              </span>
              {d.harnessSlug && <span className="pc-overview__row-tag">{d.harnessSlug}</span>}
            </div>
          ))}
        </OverviewTile>

        <OverviewTile
          icon={<Users size={14} aria-hidden />}
          title="Agents"
          count={liveAgents.length}
          accent="#a78bfa"
          error={rosterErr}
          empty={liveAgents.length === 0}
          emptyLabel="No live agents"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.agents)}
        >
          {liveAgents.map((a) => (
            <div key={a.ownerId} className="pc-overview__row">
              <span className="pc-overview__row-dot" data-live={a.liveness} aria-hidden />
              <span className="pc-overview__row-title" title={a.intent || a.label}>
                {a.intent || a.label}
              </span>
              {a.role && <span className="pc-overview__row-tag">{a.role}</span>}
            </div>
          ))}
        </OverviewTile>

        <OverviewTile
          icon={<ActivityIcon size={14} aria-hidden />}
          title="Activity"
          accent="#34d399"
          error={activityErr}
          empty={recentActivity.length === 0}
          emptyLabel="No recent activity"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.activity)}
        >
          {recentActivity.map((r) => (
            <div key={r.id} className="pc-overview__row">
              <span className="pc-overview__row-actor">{r.agent ?? '—'}</span>
              <span className="pc-overview__row-title" title={r.summary ?? r.tool_name ?? r.kind}>
                {r.summary ?? r.tool_name ?? r.kind}
              </span>
            </div>
          ))}
        </OverviewTile>
      </div>

      {/* No in-tab operator strip on desktop: ChromeShell already mounts the
          persistent OperatorChatSidebar on every non-chromeless route incl.
          /adv (Brief 24, operator-always-visible-2026-06-05) — a second
          operator surface here would duplicate it. The TUI Overview DOES
          render a bottom strip (draw_operator_dock) because the TUI has no
          shell-level sidebar. See overview-dashboard-2026-06-05 D-008. */}

      <style>{`
        .pc-overview {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 0;
          flex: 1;
          padding: 14px 16px 16px;
        }
        /* Top bar */
        .pc-overview__topbar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
          border-radius: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
        }
        .pc-overview__topbar-spacer { flex: 1; }
        .pc-overview__alerts {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 700;
          border-radius: 8px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
          background: rgba(255, 255, 255, 0.03);
          color: var(--fg-mute, #7f9bb4);
          cursor: pointer;
        }
        .pc-overview__alerts[data-has-alerts='true'] {
          color: #fca5a5;
          border-color: rgba(239, 68, 68, 0.4);
          background: rgba(239, 68, 68, 0.12);
        }
        /* Tiles grid */
        .pc-overview__grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          grid-auto-rows: minmax(0, 1fr);
          gap: 12px;
          flex: 1;
          min-height: 0;
        }
        @container (max-width: 720px) { .pc-overview__grid { grid-template-columns: 1fr; } }
        .pc-overview__tile {
          display: flex;
          flex-direction: column;
          min-height: 0;
          border: 1px solid var(--tile-accent, rgba(125, 211, 252, 0.18));
          border-radius: 14px;
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--tile-accent, #38bdf8), transparent 90%), transparent 42%),
            var(--bg-2, rgba(255, 255, 255, 0.035));
          overflow: hidden;
        }
        .pc-overview__tile-head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.12));
          color: var(--fg, #e7f7ff);
        }
        .pc-overview__tile-head svg { color: var(--tile-accent, #7dd3fc); }
        .pc-overview__tile-title { font-size: 12px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; }
        .pc-overview__tile-count {
          font-size: 11px;
          font-weight: 700;
          color: var(--bg, #07101d);
          background: var(--tile-accent, #7dd3fc);
          border-radius: 999px;
          padding: 1px 7px;
          min-width: 18px;
          text-align: center;
        }
        .pc-overview__tile-open {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 3px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--fg-mute, #7f9bb4);
          background: transparent;
          border: none;
          cursor: pointer;
        }
        .pc-overview__tile-open:hover { color: var(--fg, #e7f7ff); }
        .pc-overview__tile-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 8px 12px 10px;
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .pc-overview__tile-state { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); padding: 6px 0; }
        .pc-overview__tile-state[data-error='true'] { color: #fca5a5; }
        /* Plan rows */
        .pc-overview__plan { display: flex; flex-direction: column; gap: 4px; }
        .pc-overview__plan-head { display: flex; align-items: baseline; gap: 8px; }
        .pc-overview__plan-title {
          flex: 1; min-width: 0;
          font-size: 12px; font-weight: 600; color: var(--fg, #e7f7ff);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pc-overview__plan-frac { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-overview__bar { height: 5px; border-radius: 999px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
        .pc-overview__bar-fill {
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, #38bdf8, #34d399);
          transition: width 240ms ease;
        }
        /* Generic list rows (needs-you / agents / activity) */
        .pc-overview__row { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .pc-overview__row-dot {
          width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: #475569;
        }
        .pc-overview__row-dot[data-live='live'] { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.5); }
        .pc-overview__row-dot[data-live='idle'] { background: #facc15; }
        .pc-overview__row-dot[data-imp='urgent'] { background: #f87171; }
        .pc-overview__row-dot[data-imp='high'] { background: #fb923c; }
        .pc-overview__row-actor {
          font-size: 10.5px; font-weight: 700; color: var(--fg-mute, #7f9bb4);
          flex-shrink: 0; min-width: 40px; max-width: 64px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .pc-overview__row-title {
          flex: 1; min-width: 0;
          font-size: 12px; color: var(--fg-dim, #b9d4e8);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pc-overview__row-tag {
          font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
          color: var(--fg-mute, #7f9bb4);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
          border-radius: 5px; padding: 1px 5px; flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

/** A single dashboard tile: header (icon · title · count · open→) + body. */
function OverviewTile({
  icon,
  title,
  count,
  accent,
  loading,
  error,
  empty,
  emptyLabel,
  onOpen,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  accent?: string;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyLabel: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="pc-overview__tile"
      style={accent ? ({ ['--tile-accent' as string]: accent } as React.CSSProperties) : undefined}
    >
      <div className="pc-overview__tile-head">
        {icon}
        <span className="pc-overview__tile-title">{title}</span>
        {typeof count === 'number' && count > 0 && <span className="pc-overview__tile-count">{count}</span>}
        <button type="button" className="pc-overview__tile-open" onClick={onOpen} title={`Open ${title}`}>
          open <ArrowRight size={11} aria-hidden />
        </button>
      </div>
      <div className="pc-overview__tile-body">
        {error ? (
          <div className="pc-overview__tile-state" data-error="true">
            {error}
          </div>
        ) : loading ? (
          <div className="pc-overview__tile-state">Loading…</div>
        ) : empty ? (
          <div className="pc-overview__tile-state">{emptyLabel}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/**
 * Placeholder for Brief 20's `<FleetRateControl>` (rate-limit-layer-v2 D-004).
 * Same slots (usage% · $spend · editable max) so swapping in their exported
 * component is a one-line import change. su-0f7abe6c owns the live control;
 * this renders the layout + a "pending" marker until it exports.
 */
function FleetRateControlStub() {
  return (
    <div className="pc-overview__rate" title="Fleet rate / usage — pending Brief 20 (rate-limit-layer-v2)">
      <span className="pc-overview__rate-slot">
        <span className="pc-overview__rate-k">usage</span>
        <span className="pc-overview__rate-v">—%</span>
      </span>
      <span className="pc-overview__rate-slot">
        <span className="pc-overview__rate-k">spend</span>
        <span className="pc-overview__rate-v">$—</span>
      </span>
      <span className="pc-overview__rate-slot">
        <span className="pc-overview__rate-k">max agents</span>
        <span className="pc-overview__rate-v">—</span>
      </span>
      <span className="pc-overview__rate-pending">pending Brief 20</span>
      <style>{`
        .pc-overview__rate { display: inline-flex; align-items: center; gap: 16px; }
        .pc-overview__rate-slot { display: inline-flex; flex-direction: column; gap: 1px; }
        .pc-overview__rate-k {
          font-size: 9px; font-weight: 760; letter-spacing: 0.09em; text-transform: uppercase;
          color: var(--fg-mute, #7f9bb4);
        }
        .pc-overview__rate-v {
          font-size: 16px; font-weight: 760; color: var(--fg, #e7f7ff);
          font-variant-numeric: tabular-nums;
        }
        .pc-overview__rate-pending {
          font-size: 9.5px; font-style: italic; color: var(--fg-mute, #7f9bb4);
          border: 1px dashed var(--border, rgba(125, 211, 252, 0.25));
          border-radius: 6px; padding: 2px 6px;
        }
      `}</style>
    </div>
  );
}
