'use client';

/**
 * PlanDashboard (plan-visibility-revamp-2026-08-23 P-003) — the option-C plan
 * detail surface (canvas cf9475c1 / OptionC.dc.html), rendered full-width in
 * the app pane as a takeover (D-002; host: PlanDashboardHost). Reached from
 * the op-chat plan sidebar (D-001) — there is NO new top-level tab.
 *
 * Sections (the artboard's right-hand `.detail` half):
 *   - HEADER: bucket / title / harness·slug, back affordance, actions
 *     (Open full plan → the existing `wppop` popup; Search transcripts →
 *     the same popup's Sessions tab; Launch agent → launchAgent, the same
 *     plan-bound launch PlanSessionsTab does), ✎/⚒ meta pair, item progress,
 *     needs-you line, progress bar.
 *   - WORKING NOW: one card per live plan session (`planSessions.list`),
 *     enriched by the shared `advRoster.list` entry for that owner —
 *     liveness state, current intent, last-activity recency. Card click-through
 *     opens the session chat (SessionChatModal — same surface the popup's
 *     Sessions tab uses).
 *   - RECENT ACTIVITY: the merged edits+work feed (`planActivity.list`,
 *     P-004). Work rows deep-link to the work-item popup (`wpop`).
 *
 * REUSE, not re-derivation:
 *   - plan row: the SAME `plans.list` feed (usePlanList) every plan surface
 *     reads — shared cache entry, warm from the sidebar;
 *   - needs-you: the SAME `plans.attention` feed (useInboxAttention →
 *     effectiveTier === 'decision'), the sidebar's own join;
 *   - ⚒ last work: the SAME `planWorkActivity.list` map the sidebar rows read
 *     (identical args ⇒ one cache entry, zero extra fetches);
 *   - roster: `advRosterArgs(...)` — the ONE canonical args shape (P-026);
 *   - popups: `wpop`/`wppop` via chat-ref-popup-params — written here, rendered
 *     by ChatRefPopupHost's singleton mount. Never a second renderer.
 *
 * State lives in the URL (nuqs): `?pdash` (the host's takeover param),
 * `?pdsess` (the open session-chat owner), and `?opcln` (the selected clean-up
 * run) — deep-linkable + agent-driveable.
 */
import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, Hammer, Pencil, Plus, Search } from 'lucide-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { FLAGS } from '@papercusp/flags';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import { useSyncQuery } from '@papercusp/sync';
import { useFlag } from '@/lib/flag-hooks';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { bucketOf, usePlanList } from '@/app/admin/plans/plans-api';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import SessionChatModal from '../chat/SessionChatModal';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  encodeScopedRef,
} from '../chat/chat-ref-popup-params';
import { agoLabel, agoLabelMs, progressOf, WORK_HOT_MS } from './PlansPane';
import PlanCleanupEntryButton from './PlanCleanupEntryButton';
import {
  PLAN_CLEANUP_RUN_PARAM,
  usePlanCleanupRun,
} from './use-plan-cleanup-run';
import { advRosterArgs } from '@/lib/adv-roster-args';
import './plan-dashboard.css';

/** One row of the `planSessions.list` sync query (mirrors PlanSessionRow). */
interface PlanSessionRow {
  coordOwnerId: string;
  sessionId: string | null;
  agent: string | null;
  role: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  live: boolean;
  via: 'plan' | 'claim';
}

/** The advRoster.list payload subset this surface reads (per-owner liveness). */
interface RosterPayloadRow {
  active?: Array<{
    ownerId: string;
    label?: string | null;
    intent?: string | null;
    sessionState?: string | null;
    lastActiveAt?: string | null;
    agent?: string | null;
  }>;
}

/** One planActivity.list wire row (P-004 — PlanActivityRow). */
interface PlanActivityFeedRow {
  kind?: 'edit' | 'work';
  tsMs?: number;
  text?: string;
  who?: string;
  ref?: string;
}

/** One planWorkActivity.list wire row (P-001). */
interface PlanWorkActivityRow {
  slug?: string;
  lastWorkAtMs?: number;
}

/** "2m" → "2m ago", "now" → "just now" — hover-title phrasing. */
function agoPhrase(label: string): string {
  return label === 'now' ? 'just now' : `${label} ago`;
}

/** `su-5ae5fec0-…` → `su-5ae5f` — the short owner id the roster panes show. */
export function shortOwnerId(ownerId: string): string {
  const m = /^([a-z]+)-([0-9a-f]{5})/i.exec(ownerId);
  return m ? `${m[1]}-${m[2]}` : ownerId.slice(0, 8);
}

/** Deterministic avatar colour — the artboard's palette, hashed by owner id. */
const AVATAR_COLORS = ['#7dd3fc', '#a78bfa', '#f9a8d4', '#fbbf24', '#34d399', '#fb7185'];
export function avatarColor(ownerId: string): string {
  let h = 0;
  for (let i = 0; i < ownerId.length; i++) h = (h * 31 + ownerId.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

/** Two-glyph avatar text: the first hex pair of the owner uuid. */
function avatarText(ownerId: string): string {
  const m = /-([0-9a-f]{2})/i.exec(ownerId);
  return (m?.[1] ?? ownerId.slice(0, 2)).toLowerCase();
}

export default function PlanDashboard({
  planSlug,
  harnessSlug,
  onBack,
}: {
  planSlug: string;
  /** The plan's own harness when the deep link carried one; the plan row's
   *  harness is the fallback (a bare `?pdash=<slug>` link still resolves). */
  harnessSlug: string | null;
  onBack: () => void;
}) {
  const workspaceId = useWorkspaceId();

  // The plan row — the shared plans.list cache (warm from the sidebar).
  const planList = usePlanList({});
  const plan = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === planSlug) ?? null,
    [planList.data, planSlug],
  );
  const harness = harnessSlug ?? plan?.harness ?? null;

  // Needs-you: decision-tier attention on THIS plan (the sidebar's own join).
  const { items: attentionItems } = useInboxAttention();
  const needsYou = useMemo(
    () =>
      attentionItems.filter((i) => i.planSlug === planSlug && effectiveTier(i) === 'decision')
        .length,
    [attentionItems, planSlug],
  );

  // ⚒ last work — the SAME map the sidebar reads (identical args ⇒ shared entry).
  const workActivity = useSyncQuery<PlanWorkActivityRow>({
    queryName: 'planWorkActivity.list',
    args: { workspaceId },
  });
  const lastWorkAtMs = useMemo(() => {
    for (const r of workActivity.data ?? []) {
      if (r?.slug === planSlug && typeof r.lastWorkAtMs === 'number') return r.lastWorkAtMs;
    }
    return null;
  }, [workActivity.data, planSlug]);
  const workHot = lastWorkAtMs != null && Date.now() - lastWorkAtMs < WORK_HOT_MS;

  // Plan-bound sessions + the roster entries that carry their live state.
  const sessions = useSyncQuery<PlanSessionRow>({
    queryName: 'planSessions.list',
    args: { planSlug, workspaceId: workspaceId ?? null },
  });
  const roster = useSyncQuery<RosterPayloadRow>({
    queryName: 'advRoster.list',
    args: advRosterArgs(workspaceId),
  });
  const rosterByOwner = useMemo(() => {
    const m = new Map<string, NonNullable<RosterPayloadRow['active']>[number]>();
    for (const e of roster.data?.[0]?.active ?? []) m.set(e.ownerId, e);
    return m;
  }, [roster.data]);
  const liveRows = useMemo(
    () => (sessions.data ?? []).filter((r) => r.live),
    [sessions.data],
  );

  // The merged edits+work feed (P-004).
  const activity = useSyncQuery<PlanActivityFeedRow>({
    queryName: 'planActivity.list',
    args: { planSlug, workspaceId: workspaceId ?? null, limit: 30 },
  });

  // Open-session chat (?pdsess — deep-linkable, same modal the popup tab uses).
  const [openSessionOwner, setOpenSessionOwner] = useQueryState('pdsess', parseAsString);

  // P-009: one-plan clean-up shares the global URL-owned run selection. Reading
  // the same sync entry as PlanCleanupReportHost costs no second server query;
  // it only keeps this header action disabled while its own run is active.
  const cleanupEnabled = useFlag(FLAGS.PLAN_CLEANUP);
  const [cleanupRunId, setCleanupRunId] = useQueryState(
    PLAN_CLEANUP_RUN_PARAM,
    parseAsString,
  );
  const cleanup = usePlanCleanupRun(cleanupRunId, { enabled: cleanupEnabled });
  const cleanupActive = Boolean(
    cleanup.isRunning &&
      cleanup.run?.seedRefs.length === 1 &&
      cleanup.run.seedRefs[0] === planSlug,
  );

  // Popups: written here, rendered by ChatRefPopupHost's singleton mount.
  const [, setOpenPlanPopup] = useQueryState(CHAT_PLAN_POPUP_PARAM, parseAsString);
  const [, setOpenWorkItem] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);
  const [, setPopupView] = useQueryState('ppv', parseAsString);

  const openFullPlan = useCallback(() => {
    void setOpenPlanPopup(encodeScopedRef(harness, planSlug));
  }, [setOpenPlanPopup, harness, planSlug]);

  const openTranscriptSearch = useCallback(() => {
    // The popup's Sessions tab IS the plan-scoped transcript search surface
    // (PlanSessionsTab) — open the popup directly onto it.
    void setPopupView('sessions');
    void setOpenPlanPopup(encodeScopedRef(harness, planSlug));
  }, [setPopupView, setOpenPlanPopup, harness, planSlug]);

  const [launching, setLaunching] = useState(false);
  const onLaunch = useCallback(async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await launchAgent({
        slug: harness,
        planSlug,
        label: `plan · ${planSlug}`,
      });
      if (result.ok) {
        toast.success('Agent launching on this plan — it will appear here once it registers.', {
          duration: 3500,
        });
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'Launch prerequisites missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  }, [launching, harness, planSlug]);

  const handleBack = useCallback(() => {
    // Clear the session-chat selection with the takeover — a stale ?pdsess
    // would auto-open that chat on the NEXT dashboard visit.
    void setOpenSessionOwner(null);
    onBack();
  }, [setOpenSessionOwner, onBack]);

  const progress = plan ? progressOf(plan) : null;
  const bucket = plan ? bucketOf(plan) : null;
  const title = plan?.title ?? planSlug;

  return (
    <div className="plan-dash" data-testid="plan-dashboard">
      <div className="plan-dash__head">
        <div className="plan-dash__title-row">
          <button
            type="button"
            className="plan-dash__back"
            onClick={handleBack}
            aria-label="Back"
            data-testid="plan-dash-back"
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          {bucket ? (
            <span className={`plan-dash__bucket plan-dash__bucket--${bucket}`}>
              {bucket === 'running' ? 'plan' : bucket}
            </span>
          ) : null}
          <h1 className="plan-dash__title" title={title}>
            {title}
          </h1>
          <span className="plan-dash__slug" title={`${harness ?? '?'} · ${planSlug}`}>
            {harness ? `${harness} · ` : ''}
            {planSlug}
          </span>
          <span className="plan-dash__spacer" />
          {cleanupEnabled ? (
            <PlanCleanupEntryButton
              planSlug={planSlug}
              harness={harness}
              title={title}
              appearance="dashboard"
              active={cleanupActive}
              onRunStarted={(runId) => void setCleanupRunId(runId)}
            />
          ) : null}
          <button
            type="button"
            className="plan-dash__btn plan-dash__btn--ghost"
            onClick={openFullPlan}
            data-testid="plan-dash-open-full"
          >
            <ExternalLink size={11} aria-hidden="true" />
            Open full plan
          </button>
          <button
            type="button"
            className="plan-dash__btn plan-dash__btn--ghost"
            onClick={openTranscriptSearch}
            data-testid="plan-dash-search-transcripts"
          >
            <Search size={11} aria-hidden="true" />
            Search transcripts
          </button>
          <button
            type="button"
            className="plan-dash__btn"
            onClick={() => void onLaunch()}
            disabled={launching}
            data-testid="plan-dash-launch"
          >
            <Plus size={11} aria-hidden="true" />
            {launching ? 'Launching…' : 'Launch agent'}
          </button>
        </div>

        <div className="plan-dash__meta">
          <span
            className="plan-dash__t"
            title={
              plan?.updated
                ? `✎ Plan edited ${agoPhrase(agoLabel(plan.updated))} — ${new Date(Date.parse(plan.updated)).toLocaleString()}`
                : '✎ Plan edit time unknown'
            }
            data-testid="plan-dash-edit-t"
          >
            <Pencil size={11} aria-hidden="true" />
            edited {agoLabel(plan?.updated)}
          </span>
          <span
            className={`plan-dash__t${workHot ? ' plan-dash__t--hot' : lastWorkAtMs == null ? ' plan-dash__t--dim' : ''}`}
            title={
              lastWorkAtMs != null
                ? `⚒ Last work ${agoPhrase(agoLabelMs(lastWorkAtMs))} — ${new Date(lastWorkAtMs).toLocaleString()}`
                : '⚒ No work-item activity yet'
            }
            data-testid="plan-dash-work-t"
          >
            <Hammer size={11} aria-hidden="true" />
            worked {agoLabelMs(lastWorkAtMs)}
          </span>
          {progress ? (
            <span data-testid="plan-dash-progress">
              {progress.done} of {progress.total} items done
            </span>
          ) : null}
          {needsYou > 0 ? (
            <span className="plan-dash__needs" data-testid="plan-dash-needs">
              {needsYou} decision{needsYou === 1 ? '' : 's'} need{needsYou === 1 ? 's' : ''} you
            </span>
          ) : null}
        </div>

        {progress ? (
          <div className="plan-dash__track" aria-hidden="true">
            <span
              className="plan-dash__fill"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="plan-dash__sec">
        <div className="plan-dash__sec-h">
          Working now · {liveRows.length} agent{liveRows.length === 1 ? '' : 's'}
        </div>
        {sessions.loading && liveRows.length === 0 ? (
          <div className="plan-dash__empty">Loading sessions…</div>
        ) : liveRows.length === 0 ? (
          <div className="plan-dash__empty" data-testid="plan-dash-no-sessions">
            No agents working on this plan right now. “Launch agent” starts one.
          </div>
        ) : (
          <div className="plan-dash__sess-grid" data-testid="plan-dash-sessions">
            {liveRows.map((row) => {
              const entry = rosterByOwner.get(row.coordOwnerId);
              const state = entry?.sessionState ?? 'live';
              const parked = state !== 'live';
              const lastActive = entry?.lastActiveAt ?? null;
              const intent = entry?.intent?.trim() || row.label?.trim() || null;
              return (
                <div
                  key={row.coordOwnerId}
                  className="plan-dash__scard"
                  data-testid={`plan-dash-session-${row.coordOwnerId}`}
                >
                  <div className="plan-dash__srow1">
                    <span
                      className="plan-dash__sav"
                      style={{ background: avatarColor(row.coordOwnerId) }}
                      aria-hidden="true"
                    >
                      {avatarText(row.coordOwnerId)}
                    </span>
                    <span className="plan-dash__sid" title={row.coordOwnerId}>
                      {shortOwnerId(row.coordOwnerId)}
                    </span>
                    {row.agent ? <span className="plan-dash__backend">{row.agent}</span> : null}
                    <span
                      className={`plan-dash__state plan-dash__state--${parked ? 'parked' : 'live'}`}
                    >
                      <span className="plan-dash__state-dot" aria-hidden="true" />
                      {state}
                    </span>
                  </div>
                  {intent ? (
                    <span className="plan-dash__sintent" title={intent}>
                      {intent}
                    </span>
                  ) : null}
                  <div className="plan-dash__srow3">
                    <span>
                      {parked
                        ? `idle ${agoLabel(lastActive)}`
                        : lastActive
                          ? `last active ${agoPhrase(agoLabel(lastActive))}`
                          : `started ${agoPhrase(agoLabel(row.startedAt))}`}
                    </span>
                    <span className="plan-dash__srow3-spacer" />
                    <button
                      type="button"
                      className="plan-dash__btn"
                      onClick={() => void setOpenSessionOwner(row.coordOwnerId)}
                      data-testid={`plan-dash-open-session-${row.coordOwnerId}`}
                    >
                      Open session
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="plan-dash__sec">
        <div className="plan-dash__sec-h">
          Recent activity
          <span className="plan-dash__sec-h-note">edits + work, newest first</span>
        </div>
        {activity.loading && (activity.data ?? []).length === 0 ? (
          <div className="plan-dash__empty">Loading activity…</div>
        ) : (activity.data ?? []).length === 0 ? (
          <div className="plan-dash__empty" data-testid="plan-dash-no-activity">
            No activity on this plan yet.
          </div>
        ) : (
          <div className="plan-dash__feed" data-testid="plan-dash-feed">
            {(activity.data ?? []).map((row, i) => {
              const kind = row.kind === 'edit' ? 'edit' : 'work';
              const inner = (
                <>
                  <span className={`plan-dash__fic plan-dash__fic--${kind}`} aria-hidden="true">
                    {kind === 'edit' ? <Pencil size={11} /> : <Hammer size={11} />}
                  </span>
                  <span className="plan-dash__ftext" title={row.text}>
                    {row.text ?? ''}
                  </span>
                  <span className="plan-dash__fwho" title={row.who}>
                    {row.who ? shortOwnerId(row.who) : ''}
                  </span>
                  <span className="plan-dash__fago">
                    {typeof row.tsMs === 'number' ? agoLabelMs(row.tsMs) : '—'}
                  </span>
                </>
              );
              // A work row carries a work-item ref — deep-link it to the
              // work-item popup. Edit rows (`rev:N`) have no popup target.
              const workRef = kind === 'work' && row.ref ? row.ref : null;
              return workRef ? (
                <button
                  key={`${row.tsMs}-${i}`}
                  type="button"
                  className="plan-dash__fitem"
                  onClick={() => void setOpenWorkItem(encodeScopedRef(harness, workRef))}
                  aria-label={`Open ${workRef}`}
                  data-testid={`plan-dash-feed-ref-${workRef}`}
                >
                  {inner}
                </button>
              ) : (
                <div key={`${row.tsMs}-${i}`} className="plan-dash__fitem">
                  {inner}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <SessionChatModal
        sessionOwnerId={openSessionOwner}
        ownerLabel={openSessionOwner ? shortOwnerId(openSessionOwner) : null}
        onClose={() => void setOpenSessionOwner(null)}
      />
    </div>
  );
}
