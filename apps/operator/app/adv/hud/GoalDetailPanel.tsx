'use client';

/**
 * GoalDetailPanel (goal-mode-2026-08-07 P-021) — the goal opened from a HUD
 * goal card. The rail tab answers "is anything on fire"; this answers "I have
 * not looked in three days, what happened and what needs me".
 *
 * ── One query, one param ──────────────────────────────────────────────────
 * Everything on this page comes from `goals.detail` (resolveGoalDetail), which
 * already returns each section pre-shaped. A second query would be a second
 * clock: the projects grid and the spend chart are two readings of the same
 * ledger, and fetching them separately lets them disagree on screen.
 *
 * The open-state param is `hudgoal` — the SAME param the board uses for "the
 * selected goal", not a second `hudgoaldetail` key. Two params would let the
 * board sit scoped to goal A while this panel shows goal B, and there is no
 * reading of that screen that is not a lie about one of them. Closing the panel
 * therefore clears the selection, which is also what a second click on the card
 * does — the two exits agree.
 *
 * ⚠ `workspaceId` is REQUIRED and non-null here on purpose. `goals.detail`
 * defaults an absent workspace to the `'default'` tenant, which returns a goal
 * that renders as a healthy-looking empty page pointed at the wrong tenant (the
 * WI-5125 shape). HudView resolves the real id (`goalWorkspaceId`) for exactly
 * this reason; the type makes passing its nullable prop straight through a
 * compile error rather than a silent empty view.
 *
 * ── The frame is SessionChatModal's (P-018) ────────────────────────────────
 * [owner 2026-08-09] this popup "should mimic the design of the conversation
 * popup in the sessions tab". So it borrows that popup's shape wholesale: a
 * `pc-ctl-band--status` vitals band across the top, a scrolling body, a
 * collapsible `pc-zone` rail on the right, the popup widening to seat the rail
 * rather than crushing the body, and the rail becoming an overlay drawer on a
 * narrow window instead of silently doing nothing. The CLASSES are the same
 * ones, not lookalikes — a second vocabulary would drift the two popups apart
 * on the first restyle of either.
 *
 * IT BORROWS THE CONVERSATION TOO — see D-011 (which RETRACTED an earlier
 * ruling of mine; if you are reading that one, it is superseded).
 *
 * The retracted version said this popup should get the shape but no composer,
 * because "a goal is not a correspondent — there is nothing to send TO", and
 * offered a button routing out to the sessions popup instead. The premise was
 * sound and the conclusion did not follow. Mimicking a chat popup invites the
 * reader to expect a composer, and the owner's report is that expectation
 * arriving exactly as predicted: "I dont see a place to chat with the agent in
 * the goal popup like I do in the conversation popup". The reasoning had
 * treated "who is the message addressed to" as the design question when the
 * real one was "what does the reader expect to be able to do here". The goal's
 * AGENT is addressable, it is already on this very payload (`agents[]`), and
 * routing the owner elsewhere made this popup a dead end for the one action it
 * most obviously suggests.
 *
 * So the conversation is EMBEDDED, and embedded by REUSE: the same
 * `LiveSessionChat` the sessions popup renders, fed by the same
 * `useOwnerSessionChat` wiring. That is what keeps D-005 ("generalize
 * OperatorChat... never fork a second chat renderer") satisfied — the rule was
 * never "do not put a chat here", it was "do not build a SECOND one".
 * `onOpenAgent` survives as a secondary "open full-size" affordance, because
 * the embedded chat is width-constrained beside the work rail.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '@/app/harness/Modal';
import { Tooltip } from '@/app/harness/Tooltip';
import GoalWorkRail from './GoalWorkRail';
/* D-011: the goal popup hosts the SAME conversation the sessions popup does —
   the same renderer, fed by the same extracted wiring. Not a second chat. */
import { LiveSessionChat } from '@/app/_components/chat/SessionChatModal';
import { useOwnerSessionChat } from '@/app/_components/chat/use-owner-session-chat';
// The conversation popup's own control vocabulary (pc-ctl-band, pc-zone,
// pc-peers). Imported rather than re-declared so P-018's "mimic" is literally
// the same CSS — see the docblock.
import '@/app/_components/chat/chat-controls.css';
// Self-sufficient, the way SessionChatModal imports this same sheet: the panel
// mounts on the Goals tab, where HudBoard (the file that otherwise pulls
// hud.css in) is not the rendered branch. It works today only because HudView
// imports HudBoard at module scope, which is an accident of import order rather
// than anything this component controls.
import './hud.css';
import {
  agoText,
  ceilingLine,
  killCriterionLine,
  partitionProjects,
  spendStack,
  tripwireBars,
  workRail,
  type GoalDetailInput,
  type GoalDetailProject,
  type TripwireBar,
} from './goal-detail-model';

/* The rail's two seatings, mirroring the conversation popup's rails exactly
   (DOSSIER_RAIL_SIDE_STYLE / _OVERLAY_STYLE in SessionChatModal). Side-by-side
   when there is room — the Modal widens below to make it — and an overlaying
   drawer when there is not, so the body is never crushed. */
const RAIL_WIDTH = 288;

const RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: `0 0 ${RAIL_WIDTH}px`,
  width: RAIL_WIDTH,
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
};

/* Overlaying rather than simply not rendering, for the reason SessionChatModal
   states for its own rails: a toggle that silently does nothing on a narrow
   window reads as a broken button, not as a layout decision. */
const RAIL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  right: 0,
  width: 'min(320px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  zIndex: 5,
};

/** Below this the rail stops taking a column. The body wants ~560px and the
 *  rail 288, so two columns plus chrome need ~900. */
const RAIL_NARROW_MEDIA_QUERY = '(max-width: 900px)';

/** Same matchMedia + effect shape SessionChatModal uses for its own rails.
 *  Starts false so the server/first paint seats the rail as a column and the
 *  effect corrects it — never the reverse, which would flash an overlay over
 *  the body on every open on a wide window. */
function useIsNarrowViewport(query: string): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, [query]);
  return narrow;
}

export default function GoalDetailPanel({
  goalId,
  workspaceId,
  nowMs,
  onClose,
  onOpenWorkItem,
  onOpenAgent,
}: {
  /** The open goal — null renders nothing (closed). */
  goalId: string | null;
  /** The REAL workspace — never the nullable prop. See the docblock. */
  workspaceId: string;
  nowMs: number;
  onClose: () => void;
  /** Opens a work item in the HUD's existing popup, so the waiting-on-you and
   *  activity rows are destinations rather than dead text. */
  onOpenWorkItem?: (id: string) => void;
  /** P-018/D-011: opens the conversation of the agent RUNNING this goal, via
   *  the HUD's existing `hudsession` route. Optional — a host that cannot
   *  re-target the session popup passes nothing and the control is not
   *  rendered at all, rather than rendered dead. */
  onOpenAgent?: (ownerId: string) => void;
}) {
  const open = goalId !== null;
  const detail = useSyncQuery<GoalDetailInput>({
    queryName: 'goals.detail',
    args: { workspaceId, goalId: goalId ?? '' },
    enabled: open,
  });

  // Single row wrapping the object — the shape goals.list and
  // automation.catalog already use.
  const data = detail.data?.[0] ?? null;
  const goal = data?.goal ?? null;

  const bars = useMemo(() => tripwireBars(goal), [goal]);
  const criterion = useMemo(() => killCriterionLine(goal), [goal]);
  const ceiling = useMemo(() => ceilingLine(goal), [goal]);
  const projects = useMemo(() => partitionProjects(data?.projects), [data?.projects]);
  const stack = useMemo(() => spendStack(data?.spendByDay), [data?.spendByDay]);

  const waiting = data?.waitingOnYou ?? [];
  const activity = data?.activity ?? [];
  const rail = useMemo(() => workRail(data, nowMs), [data, nowMs]);

  /* nuqs, not useState: the rail's open-state is user-meaningful (it survives a
     reload and a shared link), and CLAUDE.md's rule is that anything
     user-meaningful goes in the URL where `ui:get_state`/`ui:dispatch` can see
     it. Defaulted OPEN — the rail is the answer to "what is under this goal",
     which is the question the popup exists to answer. */
  const [railOpen, setRailOpen] = useQueryState('hudgoalrail', parseAsBoolean.withDefault(true));
  const isRailNarrow = useIsNarrowViewport(RAIL_NARROW_MEDIA_QUERY);
  const railVisible = open && railOpen;
  /* Widen ONLY when the rail is actually seated as a column. On a narrow window
     it overlays, so widening there would grow the popup for a rail that is not
     taking any width — the mistake SessionChatModal's own comment calls out. */
  const railColumns = railVisible && !isRailNarrow ? RAIL_WIDTH + 16 : 0;

  /* D-006: one directed agent, one goal — so this is the normal case. A second
     stamp is surfaced rather than hidden (see the resolver), but the band's
     control targets the most recent, which is the one a reader means by "the
     agent running this goal". */
  const agents = data?.agents ?? [];
  const primaryAgent = agents[0] ?? null;

  /* D-011: the live conversation with the agent running this goal. Passing null
     when there is no agent is what keeps the hook from resolving a session or
     opening a stream — an agent-less goal must render a plain statement, never
     an inert composer that looks live and can reach nobody. */
  const chat = useOwnerSessionChat(primaryAgent?.ownerId ?? null);
  /* Only a MOUNTED transcript claims height. Every other state (no agent,
     resolving, no session, error) is a single line. */
  const chatLive = Boolean(primaryAgent && chat.resolved && chat.streamUrl);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={goal?.title?.trim() || goalId || 'Goal'}
      description="Goal detail"
      srOnlyTitle
      /* The conversation popup's own frame: flex column, no padding of its own
         (the bands and body own their spacing), and a width that grows to seat
         the rail instead of squeezing the body. */
      contentStyle={{
        width: `min(${880 + railColumns}px, ${railColumns > 0 ? 97 : 92}vw)`,
        height: 'min(80vh, 820px)',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
          position: 'relative',
        }}
        data-testid="goal-detail-modal"
      >
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* ── VITALS BAND ─────────────────────────────────────────────────
              SessionChatModal's `SessionStateHeader` in goal vocabulary: the
              handful of facts that decide whether the reader needs to act,
              before any scrolling. Status, what ends the goal, what it has
              spent against its ceiling, and how many things are parked on the
              owner — the four the goal card promises and used to make the
              reader hunt for. */}
          <div
            className="pc-ctl-band pc-ctl-band--status"
            data-testid="goal-vitals"
            role="status"
          >
            <span className="pc-zone-cap">Goal</span>
            {goal?.status ? (
              <span className="pc-ctl-state" title={`Status: ${goal.status}`}>
                <span className="pc-ctl-state__dot" aria-hidden="true" />
                {goal.status}
              </span>
            ) : null}
            {goal ? (
              <span
                className={`pc-ctl-state${criterion.missing ? ' pc-ctl-state--warn' : ''}`}
                title={criterion.text}
              >
                <span className="pc-ctl-band__label">ends when</span>
                <span className="pc-ctl-state__clip">{criterion.text}</span>
              </span>
            ) : null}
            {goal ? (
              <span
                className={`pc-ctl-state${ceiling.over ? ' pc-ctl-state--bad' : ''}`}
                title={data?.spendNote ?? undefined}
              >
                <span className="pc-ctl-band__label">{data?.spendLabel ?? 'fleet spend'}</span>
                {ceiling.text}
              </span>
            ) : null}
            {waiting.length > 0 ? (
              <span className="pc-ctl-state pc-ctl-state--warn" title="Parked on you">
                {waiting.length} waiting on you
              </span>
            ) : null}

            <span className="pc-ctl-band__spacer" />

            {/* D-011: the ONE conversation affordance — a route to the agent's
                existing conversation, never a composer of this popup's own.
                Rendered only when there IS an agent and the host can route to
                it, so it is never a button that looks live and is not. */}
            {primaryAgent && onOpenAgent ? (
              /* The shared Tooltip primitive, NOT a `title=` attribute — a
                 native title is unreachable by keyboard and on touch, and
                 `lint:design-primitives` fails a title on a <button> for
                 exactly that reason (it is a green-checkpoint LEG, so this is
                 a fleet-wide red, not a style nit). FleetPeersRail carries the
                 same note over the same decision. */
              <Tooltip
                label={`Open this conversation full-size in the sessions popup (${primaryAgent.ownerId})`}
                side="bottom"
              >
                <button
                  type="button"
                  className="pc-button"
                  data-testid="goal-open-agent"
                  onClick={() => onOpenAgent(primaryAgent.ownerId)}
                >
                  Open full-size
                </button>
              </Tooltip>
            ) : null}
            <button
              type="button"
              className="pc-button"
              onClick={() => void setRailOpen(!railOpen)}
              aria-pressed={railOpen}
              aria-label={railOpen ? 'Hide plans and work items' : 'Show plans and work items'}
              data-testid="goal-rail-toggle"
            >
              {railOpen ? 'Hide work' : 'Work'}
            </button>
          </div>

          {/* The scrolling body. `minHeight: 0` is load-bearing inside a flex
              column — without it the body grows past the popup instead of
              scrolling within it, and the vitals band scrolls away with it. */}
          <div className="hud-goal" data-testid="goal-detail" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <header className="hud-goal__head">
              <div className="hud-goal__title-row">
                <h2 className="hud-goal__title">{goal?.title?.trim() || goalId}</h2>
                {/* The status chip moved UP into the vitals band (P-018) rather
                    than being rendered in both places. Two copies of one status
                    is how a stale one goes unnoticed — the band is the glance,
                    so the band owns it. */}
              </div>
              {goal?.body?.trim() ? <p className="hud-goal__body">{goal.body.trim()}</p> : null}
            </header>

        {detail.loading && !data ? <p className="hud__state">Loading goal…</p> : null}
        {detail.error ? (
          <p className="hud__state hud__state--error">Could not load this goal: {String(detail.error)}</p>
        ) : null}
        {!detail.loading && !detail.error && data && !goal ? (
          <p className="hud__state">
            This goal no longer exists. It may have been deleted since the board last loaded.
          </p>
        ) : null}

        {goal ? (
          <>
            {/* ── 1. THIS GOAL ENDS WHEN ──────────────────────────────────
                First, and first for a reason: it is the only section that says
                when the goal STOPS. Everything below it describes activity,
                which a goal with no stopping condition will produce forever. */}
            <section className="hud-goal__section hud-goal__section--ends">
              <h3 className="hud-goal__h">This goal ends when</h3>
              <p
                className={`hud-goal__criterion${criterion.missing ? ' hud-goal__criterion--missing' : ''}`}
                data-testid="goal-kill-criterion"
              >
                {criterion.text}
              </p>

              {/* Bars are OPTIONAL. A free-text criterion with none is the
                  normal case and renders as prose alone — no empty chart, no
                  "0 tripwires" placeholder implying something is missing. */}
              {bars.length > 0 ? (
                <ul className="hud-goal__bars" data-testid="goal-tripwires">
                  {bars.map((b) => (
                    <TripwireRow key={b.key} bar={b} />
                  ))}
                </ul>
              ) : null}

              <div className="hud-goal__ceiling" title={data?.spendNote ?? undefined}>
                <span className="hud-goal__ceiling-label">{data?.spendLabel ?? 'fleet spend'}</span>
                <span
                  className={`hud-goal__ceiling-value${ceiling.over ? ' hud-goal__ceiling-value--over' : ''}`}
                >
                  {ceiling.text}
                </span>
              </div>
            </section>

            {/* ── 2. WAITING ON YOU ───────────────────────────────────────
                Above projects and activity because it is the only section the
                owner can ACT on — the rest is read-only reporting. */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">
                Waiting on you
                {waiting.length > 0 ? <span className="hud__chip hud__chip--warn">{waiting.length}</span> : null}
              </h3>
              {waiting.length === 0 ? (
                <p className="hud-goal__empty">Nothing is parked on you.</p>
              ) : (
                <ul className="hud-goal__rows">
                  {waiting.map((w) => (
                    <li key={w.id} className="hud-goal__row">
                      <RowButton id={w.id} title={w.title} onOpen={onOpenWorkItem} />
                      <span className="hud-goal__row-meta">
                        {w.harnessSlug ?? '—'} · {agoText(w.updatedAt, nowMs) ?? 'unknown age'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 3. PROJECTS ─────────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">Projects</h3>
              {projects.active.length === 0 && projects.removed.length === 0 ? (
                <p className="hud-goal__empty">No projects serve this goal yet.</p>
              ) : null}
              {projects.active.length > 0 ? (
                <div className="hud-goal__grid" data-testid="goal-projects">
                  {projects.active.map((p) => (
                    <ProjectCard key={p.harnessSlug} project={p} />
                  ))}
                </div>
              ) : null}

              {/* Killed projects STAY, greyed. If they vanished, the page would
                  only ever show growth — and "the agent actually closes things"
                  is the one behaviour the owner most needs to confirm, so it
                  must stay visible exactly when it is working. */}
              {projects.removed.length > 0 ? (
                <>
                  <h4 className="hud-goal__h4">Closed ({projects.removed.length})</h4>
                  <div className="hud-goal__grid" data-testid="goal-projects-closed">
                    {projects.removed.map((p) => (
                      <ProjectCard key={p.harnessSlug} project={p} nowMs={nowMs} />
                    ))}
                  </div>
                </>
              ) : null}
            </section>

            {/* ── 4. ACTIVITY ─────────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">Activity</h3>
              {activity.length === 0 ? (
                <p className="hud-goal__empty">Nothing has moved under this goal yet.</p>
              ) : (
                <ul className="hud-goal__rows">
                  {activity.map((a) => (
                    <li key={a.id} className="hud-goal__row">
                      <span
                        className={`hud__dot hud__dot--${a.closedAt ? 'done' : 'working'}`}
                        aria-hidden="true"
                      />
                      <RowButton id={a.id} title={a.title} onOpen={onOpenWorkItem} />
                      <span className="hud-goal__row-meta">
                        {a.closedAt ? 'closed' : (a.status ?? 'open')} ·{' '}
                        {agoText(a.updatedAt, nowMs) ?? 'unknown age'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 5. SPEND BY DAY ─────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">{data?.spendLabel ?? 'fleet spend'} by day</h3>
              {/* D-021: per-goal spend figures do NOT sum across goals — a
                  shared project counts in full against each. The caveat rides
                  with the chart because this is the section most likely to be
                  screenshotted into a report. */}
              {data?.spendNote ? <p className="hud-goal__note">{data.spendNote}</p> : null}
              {stack.days.length === 0 ? (
                <p className="hud-goal__empty">No spend recorded for this goal yet.</p>
              ) : (
                <div className="hud-goal__chart" data-testid="goal-spend-chart">
                  {stack.days.map((d) => (
                    <div
                      key={d.day}
                      className="hud-goal__col"
                      title={`${d.day} · $${d.totalUsd.toFixed(2)}`}
                    >
                      <div className="hud-goal__col-track">
                        <div className="hud-goal__col-fill" style={{ height: `${d.heightPct}%` }}>
                          {d.slices.map((s) => (
                            <span
                              key={s.harnessSlug}
                              className="hud-goal__slice"
                              style={{ height: `${s.pct}%` }}
                              title={`${s.harnessSlug} · $${s.costUsd.toFixed(2)}`}
                            />
                          ))}
                        </div>
                      </div>
                      <span className="hud-goal__col-label">{d.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

            <footer className="hud-goal__foot">
              <button type="button" className="hud-goal__close" onClick={onClose}>
                Close
              </button>
            </footer>
          </div>

          {/* ── THE LIVE CONVERSATION (D-011) ──────────────────────────────────
              A SIBLING of the scrolling body, not a child of it — for the same
              reason the rail is: a transcript has its own scroll, and nesting
              one inside another is the layout that makes a chat feel broken.
              As siblings, goal detail scrolls above while the composer stays
              pinned at the bottom of the popup, which is where the owner
              expects it from the conversation popup.

              This renders the SAME `LiveSessionChat` the sessions popup does,
              fed by the same `useOwnerSessionChat` wiring (D-005: never fork a
              second chat renderer).

              The region only claims its share of the height when a live chat is
              actually mounted; every other state is one line, and reserving 46%
              of the popup to say "no agent" would push the goal's own detail
              off screen to display an absence. */}
          <div
            data-testid="goal-chat"
            style={{
              flex: chatLive ? '0 0 46%' : '0 0 auto',
              minHeight: chatLive ? 220 : undefined,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              borderTop: '1px solid var(--border)',
            }}
          >
            {!primaryAgent ? (
              /* D-011: a plain statement, never an inert composer. A composer
                 that looks live and can reach nobody is worse than none. */
              <p className="hud__state" data-testid="goal-chat-no-agent">
                No agent is running this goal yet, so there is no conversation to
                show. Starting a goal launches the agent that owns it.
              </p>
            ) : chat.resolving ? (
              <p className="hud__state">Finding this agent&rsquo;s conversation…</p>
            ) : chat.resolveError ? (
              <p className="hud__state hud__state--error" data-testid="goal-chat-error">
                Could not load the conversation: {chat.resolveError}
              </p>
            ) : !chat.resolved ? (
              <p className="hud__state" data-testid="goal-chat-no-session">
                No recent Claude session found for this agent.
              </p>
            ) : chat.streamUrl ? (
              <LiveSessionChat
                streamUrl={chat.streamUrl}
                sessionOwnerId={primaryAgent.ownerId}
                agentName={primaryAgent.ownerId}
                onSend={chat.send}
                sending={chat.sending}
                sendError={chat.sendError}
              />
            ) : null}
          </div>
        </div>

        {/* ── THE WORK RAIL (P-019) ──────────────────────────────────────────
            A SIBLING of the body column, never a child of it — the same layout
            contract SessionChatModal's rails hold to. Nesting it inside the
            scrolling body would make it scroll away with the content, which is
            the opposite of what a rail is for. */}
        {railVisible ? (
          <div
            className="pc-zone pc-zone--peers"
            data-testid="goal-work-rail"
            style={isRailNarrow ? RAIL_OVERLAY_STYLE : RAIL_SIDE_STYLE}
          >
            <GoalWorkRail
              model={rail}
              nowMs={nowMs}
              onOpenWorkItem={onOpenWorkItem}
              onClose={() => void setRailOpen(false)}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** A work-item row. A button only when there is somewhere to go — the dead
 *  `<button>` WI-6742 filed was a card rendered clickable with no handler. */
function RowButton({
  id,
  title,
  onOpen,
}: {
  id: string;
  title: string;
  onOpen?: (id: string) => void;
}) {
  if (!onOpen) return <span className="hud-goal__row-title">{title}</span>;
  return (
    <button type="button" className="hud-goal__row-title hud-goal__row-title--link" onClick={() => onOpen(id)}>
      {title}
    </button>
  );
}

function TripwireRow({ bar }: { bar: TripwireBar }) {
  return (
    <li className={`hud-goal__bar hud-goal__bar--${bar.tone}`} title={bar.title}>
      <span className="hud-goal__bar-label">{bar.label}</span>
      <span className="hud-goal__bar-track">
        {/* An unread tripwire gets NO fill at all — not a zero-width one. A
            0% bar and "nobody measured this" must not look identical. */}
        {bar.pct == null ? (
          <span className="hud-goal__bar-unread" />
        ) : (
          <span className="hud-goal__bar-fill" style={{ width: `${bar.pct}%` }} />
        )}
      </span>
      <span className="hud-goal__bar-value">{bar.valueText}</span>
    </li>
  );
}

function ProjectCard({ project, nowMs }: { project: GoalDetailProject; nowMs?: number }) {
  const removedAgo = nowMs != null ? agoText(project.removedAt, nowMs) : null;
  return (
    <article className={`hud-goal__proj${project.removed ? ' hud-goal__proj--removed' : ''}`}>
      <div className="hud-goal__proj-head">
        <span className="hud-goal__proj-slug">{project.harnessSlug}</span>
        {project.role === 'owner' ? <span className="hud__chip hud__role">main</span> : null}
        {project.sharedBadge ? <span className="hud__chip">{project.sharedBadge}</span> : null}
      </div>
      <p
        className={`hud-goal__proj-crit${project.killCriterionMissing ? ' hud-goal__proj-crit--missing' : ''}`}
      >
        {project.killCriterionText}
      </p>
      <div className="hud-goal__proj-meta">
        <span>${Math.round(project.spendUsd ?? 0).toLocaleString('en-US')}</span>
        <span>{project.openWorkItems ?? 0} open</span>
        {project.removed ? <span>closed{removedAgo ? ` ${removedAgo}` : ''}</span> : null}
      </div>
      {/* The note is the REASON a project was closed — the whole value of
          keeping killed projects on the page. */}
      {project.removed && project.note?.trim() ? (
        <p className="hud-goal__proj-note">{project.note.trim()}</p>
      ) : null}
    </article>
  );
}
