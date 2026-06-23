import { useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { ArrowRight, ListChecks, Users, Bell, Activity as ActivityIcon } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { deriveLiveness } from '@papercusp/operator-core/lib/liveness';
import { getBrowserWorkspaceId } from '@papercusp/operator-core/lib/browser-workspace';
import FleetRateControl from './FleetRateControl';
import {
  usePlanList,
  usePlanAttention,
  type PlanListRow,
  type AttentionItem,
  type AttentionTier,
  type ItemStatus,
} from '@/app/admin/plans/plans-api';
import { Tooltip } from '@/app/harness/Tooltip';

/**
 * Brief 23 — the Overview / dashboard: the default landing surface of /adv.
 *
 * Composition only (see plan overview-dashboard-2026-06-05, D-003): this owns
 * the tiles + layout; it CONSUMES peers' surfaces:
 *   - top-bar rate/usage/max control  → Brief 20 `<FleetRateControl>` (LIVE —
 *     ./FleetRateControl, rate-limit-layer-v2 P-013).
 *   - NEEDS-YOU tiered inbox           → Brief 21 (we read `needsHuman` off the
 *     attention feed, which Brief 21 is fixing AT THE SOURCE — so this tile
 *     auto-sharpens when their fix lands; no re-derivation here).
 *   - operator strip                   → Brief 24 desktop docked pane (placeholder
 *     strip until their dock lands; P-013).
 *
 * Tiles read GROUND-TRUTH PG state (plans list, attention, roster, activity) —
 * NOT the operator's `<report>` (D-002) — so they're correct even when the
 * operator is idle. Each tile clicks through to its full tab (D-007).
 *
 * Both tiles read via @papercusp/sync (one audited path), replacing the old 8s
 * setInterval over /api/adv/roster + /api/agent-tools/activity/recent
 * (data-sync-push-completion P-006). Their LIVENESS differs by source:
 *  - Roster → `dev.coordPresence`: SSE PUSH-driven (coord_presence carries the
 *    emit_change_notify trigger, so a heartbeat/intent/claim write invalidates live).
 *  - Activity → `userActions.byHarness` / `userActions.recent` (All-Pots): user_actions
 *    is an APPEND-HEAVY log INTENTIONALLY excluded from the per-row change-notify trigger
 *    (a per-row pg_notify on a high-write log is the notify-storm anti-pattern —
 *    cache-tag-trigger-coverage's COVERAGE_EXEMPT; mig 376). So it CANNOT SSE-push today;
 *    it carries a bounded `pollIntervalMs` (the AdvEvalsTab pattern, plan D-001) to keep
 *    the feed live — restoring the cadence the old 8s poll had. (When the append-heavy
 *    DEBOUNCED-invalidation follow-up lands — COVERAGE_EXEMPT's P-005 TODO — the poll can
 *    drop. Found live: data-sync-push-completion D-011.)
 */

// ── roster: the subset of a `dev.coordPresence` PresenceRecord the Agents tile
//    renders, after mapping (ownerLabel→label, agentRole→role, source→agent) +
//    a client-derived liveness (deriveLiveness on heartbeatAt). ─────────────
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

// ── one `dev.coordPresence` row (PresenceRecord — the fields this tile maps).
//    The resolver already filters out stale rows server-side; we still derive
//    a live/idle class for the dot from heartbeatAt. ────────────────────────
interface PresenceRow {
  ownerId: string;
  ownerLabel: string;
  intent: string;
  currentFiles: string[];
  currentPlanSlug: string | null;
  agentRole: string | null;
  source: string;
  heartbeatAt: string;
  stale?: boolean;
}

// ── activity: the subset of a `userActions.byHarness` row the Activity tile
//    renders. `user_actions` has no agent/tool_name/created_at columns — the
//    actor is `actor`, the title is `summary ?? kind`, keyed by `id`. ───────
export interface OverviewActivityRow {
  id: string;
  agent: string | null;
  kind: string;
  summary: string | null;
  status: string | null;
}

// ── one `userActions.byHarness` row (the `harness_shared.user_actions` shape:
//    drizzle camelCase columns). ─────────────────────────────────────────────
interface UserActionRow {
  id: string | number;
  harnessSlug: string;
  kind: string;
  status: string;
  summary: string | null;
  actor: string | null;
  startedAt: number;
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

  // The selected harness (AdvShell's `?slug=`). The Activity tile scopes to it when
  // set (userActions.byHarness); in the All-Pots default (null) it falls back to the
  // fleet-wide userActions.recent feed so the tile is never blank (D-008 follow-up to
  // the P-006 behavior shift).
  const [activeSlug] = useQueryState('slug', parseAsString);

  const plansQ = usePlanList({ includeArchived: false, includeLegacy: false });
  const attentionQ = usePlanAttention();

  // Roster (live fleet) — LIVE via dev.coordPresence (push-driven by the
  // coord_presence→query bridge). Workspace-scoped server-side (no args). The
  // resolver already drops stale rows; we keep selectLiveAgents' stale filter as
  // a belt-and-braces guard on the client-derived liveness.
  const rosterQ = useSyncQuery<PresenceRow>({ queryName: 'dev.coordPresence', staleTime: 8_000 });

  // Activity (recent action stream). A harness selected → userActions.byHarness (that
  // harness + workspace); All-Pots (no harness) → the fleet-wide userActions.recent feed.
  // One unconditional hook with a computed query (rules-of-hooks safe); the cache key
  // carries the queryName + args so switching scope re-subscribes. user_actions is
  // append-heavy → no per-row SSE push (see the file header), so a bounded pollIntervalMs
  // keeps the feed live (the AdvEvalsTab/D-001 pattern). It's the read side of a small
  // indexed limit-50 SELECT, NOT the write-side per-row notify the exclusion avoids.
  const activityWsId = getBrowserWorkspaceId();
  const ACTIVITY_POLL_MS = 8_000;
  const activityQ = useSyncQuery<UserActionRow>(
    activeSlug
      ? {
          queryName: 'userActions.byHarness',
          args: { harnessSlug: activeSlug, workspaceId: activityWsId, limit: ACTIVITY_LIMIT },
          staleTime: 8_000,
          pollIntervalMs: ACTIVITY_POLL_MS,
        }
      : {
          queryName: 'userActions.recent',
          args: { workspaceId: activityWsId, limit: ACTIVITY_LIMIT },
          staleTime: 8_000,
          pollIntervalMs: ACTIVITY_POLL_MS,
        },
  );

  // ── derive tile data (pure helpers, exported + unit-tested) ────────────
  const plans = useMemo(() => selectActivePlans(plansQ.data?.plans ?? []), [plansQ.data]);
  const attentionItems = useMemo(
    () => (attentionQ.data?.groups ?? []).flatMap((g) => g.items ?? []),
    [attentionQ.data],
  );
  const decisions = useMemo(() => selectDecisions(attentionItems), [attentionItems]);
  const alertCount = useMemo(() => countAlerts(attentionItems), [attentionItems]);

  // Map PresenceRecord rows → OverviewRosterEntry (deriving live/idle from the
  // heartbeat), then top-N live via the pinned pure selector.
  const roster = useMemo<OverviewRosterEntry[]>(() => {
    const now = Date.now();
    return (rosterQ.data ?? [])
      .filter((p) => !p.stale)
      .map((p) => ({
        ownerId: p.ownerId,
        label: p.ownerLabel,
        intent: p.intent,
        currentFiles: p.currentFiles ?? [],
        liveness: deriveLiveness(p.heartbeatAt, now),
        currentPlanSlug: p.currentPlanSlug,
        role: p.agentRole,
        agent: p.source,
      }));
  }, [rosterQ.data]);
  const liveAgents = useMemo(() => selectLiveAgents(roster), [roster]);

  // Map user_actions rows → the Activity tile's render shape (actor = `actor`,
  // title = `summary ?? kind`). Newest-first already (resolver orders by
  // startedAt desc); take the top 10 the tile shows.
  const recentActivity = useMemo<OverviewActivityRow[]>(
    () =>
      (activityQ.data ?? []).slice(0, 10).map((r) => ({
        id: String(r.id),
        agent: r.actor,
        kind: r.kind,
        summary: r.summary,
        status: r.status,
      })),
    [activityQ.data],
  );

  return (
    <div className="pc-overview">
      {/* ── Top bar: Brief 20 FleetRateControl (live) + alerts ─────────── */}
      <div className="pc-overview__topbar">
        <FleetRateControl />
        <div className="pc-overview__topbar-spacer" />
        <Tooltip label="Alerts — smoke failures + escalations">
          <button
            type="button"
            className="pc-overview__alerts"
            data-has-alerts={alertCount > 0}
            aria-label="Open alerts"
            onClick={() => void openInbox('alert')}
          >
            <Bell size={13} aria-hidden />
            <span>{alertCount}</span>
          </button>
        </Tooltip>
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
          loading={rosterQ.loading && !rosterQ.data}
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
          loading={activityQ.loading && !activityQ.data}
          empty={recentActivity.length === 0}
          emptyLabel="No recent activity"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.activity)}
        >
          {recentActivity.map((r) => (
            <div key={r.id} className="pc-overview__row">
              <span className="pc-overview__row-actor">{r.agent ?? '—'}</span>
              <span className="pc-overview__row-title" title={r.summary ?? r.kind}>
                {r.summary ?? r.kind}
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
        .pc-overview__tile-title { font-size: 12px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; }
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
          letter-spacing: 0;
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
          background: linear-gradient(90deg, var(--accent, #38bdf8), var(--good, #34d399));
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
          font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
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
        <Tooltip label={`Open ${title}`}>
          <button type="button" className="pc-overview__tile-open" aria-label={`Open ${title}`} onClick={onOpen}>
            open <ArrowRight size={11} aria-hidden />
          </button>
        </Tooltip>
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
