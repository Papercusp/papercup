'use client';

/**
 * HudBoard — the presentational half of /adv/HUD (adv-hud-fleet-board-2026-07-25
 * P-003). Columns are states, cards are sessions, colour is fleet.
 *
 * This file renders; it does not decide. Every classification, badge and rollup
 * arrives already computed from `hud-board-model.ts` so the logic is testable
 * without a DOM (plan P-002). If you need a new signal on a card, derive it in
 * the model and render it here.
 *
 * Deliberately NOT built on `app/harness/Kanban.tsx` (plan D-001): that
 * primitive is a dnd-kit sortable board, and HUD's columns are DERIVED from
 * live session state. A drag handle would promise that moving a card changes
 * what the agent is doing — it cannot. Cards are buttons that open the session,
 * nothing more.
 */

import { memo, useMemo, type ReactNode } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';
import { Combobox, type ComboboxOption } from '@/app/harness/Combobox';
import FleetRoleGlyph from '@/app/_components/FleetRoleGlyph';
import {
  ALL_FLEETS,
  ALL_PLANS,
  NO_PLAN_TOKEN,
  SOLO_FLEET_KEY,
  formatAge,
  type HudBoard as HudBoardData,
  type HudBadge,
  type HudColumnId,
  type HudFleetRollup,
  type HudSession,
} from './hud-board-model';
import { HUD_TABS, HUD_TAB_LABEL, type HudTabId } from './hud-entity-board';
import './hud.css';

const CHIP_TONE_CLASS: Record<HudBadge['tone'], string> = {
  neutral: '',
  accent: 'hud__chip--accent',
  good: 'hud__chip--good',
  warn: 'hud__chip--warn',
  bad: 'hud__chip--bad',
};

/** Chips are capped so a busy card can't grow unbounded; the model already
 *  orders them by decision value, so the survivors are the useful ones.
 *  Mode chips are exempt (see SessionCard) — this caps the derived stats. */
const MAX_CHIPS = 4;

/**
 * A chip's classes: tone, plus the mode modifiers.
 *
 * A standing mode is a different KIND of thing from a statistic — it is the
 * posture the agent is operating under — so it reads as a mode chip rather than
 * borrowing the accent tone it happens to share with LEAD. Owner-directed modes
 * get a second modifier: you armed that one, and a peer agent cannot override it.
 */
function chipClass(b: HudBadge): string {
  const tone = CHIP_TONE_CLASS[b.tone];
  if (b.kind !== 'mode') return `hud__chip ${tone}`;
  return `hud__chip ${tone} hud__chip--mode${b.ownerDirected ? ' hud__chip--mode-owner' : ''}`;
}

export interface HudBoardProps {
  board: HudBoardData;
  /** Fleet slugs currently selected (empty = all). `null` = the solo group. */
  selectedFleets: Array<string | null>;
  onToggleFleet: (slug: string | null) => void;
  /**
   * Plans currently selected (empty = all). `null` = the no-plan group — the
   * same array contract `selectedFleets` uses, so the two filters compose in
   * the model without either knowing about the other. The CONTROL is
   * single-select (see the plan filter below), so this holds 0 or 1 entries
   * today; the array shape is what keeps `hudplan` a superset of `hudfleet`'s
   * URL contract rather than a second, differently-shaped one.
   */
  selectedPlans: Array<string | null>;
  /** `ALL_PLANS` clears the filter; `null` selects the no-plan group. Mirrors
   *  `onToggleFleet`'s sentinel contract exactly. */
  onSelectPlan: (slug: string | null) => void;
  /** Column filter — when set, only this column is shown expanded. */
  focusColumn: HudColumnId | null;
  onFocusColumn: (id: HudColumnId | null) => void;
  suOnly: boolean;
  onToggleSuOnly: () => void;
  onOpenSession: (ownerId: string) => void;
  loading: boolean;
  error: string | null;
  /**
   * Sessions-board search box (owner ask 2026-07-26). Unlike the entity tabs'
   * filter this does NOT narrow rows already on screen — HudView runs it against
   * every session's full TURN HISTORY server-side and hands down an already
   * narrowed `board`, so this component stays presentation-only.
   */
  sessionQuery?: string;
  onSessionQuery?: (q: string) => void;
  /** True while a transcript search is narrowing the board — drives the empty copy,
   *  so "no session matched your search" never reads as "no sessions are running". */
  searchActive?: boolean;
  /**
   * Slot rendered at the right edge of the board header, before the
   * su-only toggle — the "+ New session" launch control
   * (hud-consolidation-2026-07-26 P-001). A slot rather than a fixed
   * component so this file stays presentation-only and testable without
   * mocking a live plan-list fetch (see the file docblock); HudView
   * supplies the real `<NewSessionLauncher />`, tests can omit it or pass a
   * stub node.
   */
  headerAction?: ReactNode;
  /**
   * Which board is showing (hud-session-launcher-and-board-tabs-2026-07-26
   * P-009). `sessions` renders everything below — the su-only toggle, the
   * column counts, the fleet strip and the session columns. The other tabs
   * render `entityView` instead: those controls are session CONCEPTS (a plan
   * has no fleet, a work item has no context window), so showing them on a
   * plans board would be chrome that lies.
   */
  tab: HudTabId;
  onSelectTab: (tab: HudTabId) => void;
  /**
   * Body for the non-session tabs. A slot, for the same reason `headerAction`
   * is one: this file stays presentation-only and testable without mocking a
   * live plan-list fetch. HudView supplies the real `<HudEntityColumns />`.
   */
  entityView?: ReactNode;
}

function SessionCard({
  session,
  onOpen,
}: {
  session: HudSession;
  onOpen: (ownerId: string) => void;
}) {
  // Mode chips are never truncated: they are the agent's standing posture (is my
  // silence fine, or am I the thing blocking it?), and an agent stacking
  // auto+ideate+grade would otherwise spend the whole cap on modes and hide its
  // claims and asks. Only the derived stats compete for MAX_CHIPS.
  const modeChips = session.badges.filter((b) => b.kind === 'mode');
  const statChips = session.badges.filter((b) => b.kind !== 'mode');
  const chips = [...modeChips, ...statChips.slice(0, MAX_CHIPS)];
  const overflow = statChips.length - Math.min(statChips.length, MAX_CHIPS);
  return (
    <button
      type="button"
      className={`hud__card hud__card--${session.column}`}
      style={session.fleetColor ? ({ '--hud-fleet': session.fleetColor } as React.CSSProperties) : undefined}
      onClick={() => onOpen(session.ownerId)}
      aria-label={`${session.handle} — ${session.reason}`}
    >
      {/* Flex row lives on this inner span, never the <button> itself — see
          the WebKitGTK note on .hud__card in hud.css. */}
      <span className="hud__card-row">
        <span className="hud__rail" aria-hidden="true" />
        <span className="hud__card-b">
          <span className="hud__card-h">
            <span className={`hud__dot hud__dot--${session.column}`} aria-hidden="true" />
            <span className="hud__handle">{session.handle}</span>
            {session.isLeader ? <FleetRoleGlyph role="leader" className="hud__role" /> : null}
            <span className="hud__age">{formatAge(session.sinceSec)}</span>
          </span>

          {/* The reason IS the content — for Blocked/Stalled it is the finding,
              not a label. Intent is the reason for a working session. */}
          <span className="hud__reason">{session.reason}</span>

          {session.planSlug ? <span className="hud__plan">{session.planSlug}</span> : null}

          {chips.length > 0 ? (
            <span className="hud__chips">
              {chips.map((b) =>
                b.title ? (
                  <Tooltip key={b.id} label={b.title}>
                    <span className={chipClass(b)}>{b.label}</span>
                  </Tooltip>
                ) : (
                  <span key={b.id} className={chipClass(b)}>
                    {b.label}
                  </span>
                ),
              )}
              {overflow > 0 ? <span className="hud__chip">+{overflow}</span> : null}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

const MemoSessionCard = memo(SessionCard);

/* The unattributed-ask card used to live here — a full-width strip above the
   session columns, the coverage gate hud-consolidation-2026-07-26 P-002 put in
   place before the sidebar Inbox could be retired (D-001).
   `hud-session-launcher-and-board-tabs-2026-07-26` P-009 RE-HOMED it, it did
   not delete it: the owner's ask was that "the section show[ing] the work items
   above" become its own tab, so those asks now render as cards in the Work
   items board's needs-you column (`askToCard` in hud-entity-board.ts, deduped
   against the canonical work-item rows). The P-002 gate still holds — the asks
   are visible, in a place that names them — and this file no longer carries a
   second card renderer. */

function FleetChip({
  fleet,
  selected,
  onToggle,
}: {
  fleet: HudFleetRollup;
  selected: boolean;
  onToggle: (slug: string | null) => void;
}) {
  return (
    <button
      type="button"
      className="hud__fleet"
      aria-pressed={selected}
      onClick={() => onToggle(fleet.fleetSlug)}
      style={fleet.fleetColor ? ({ '--hud-fleet': fleet.fleetColor } as React.CSSProperties) : undefined}
    >
      {/* Flex row on the inner span — see the WebKitGTK note on .hud__fleet
          in hud.css. */}
      <span className="hud__fleet-row">
        <span className="hud__fleet-swatch" aria-hidden="true" />
        <span>{fleet.label}</span>
        <span className="hud__fleet-n">{fleet.total}</span>
        {/* Present only when something is wrong, so the strip stays quiet when
            the fleet is healthy — an absent warning is itself information. */}
        {fleet.warning ? <span className="hud__fleet-warn">· {fleet.warning}</span> : null}
      </span>
    </button>
  );
}

/**
 * The plan filter's rows (P-004).
 *
 * Built as Combobox options rather than a second chip strip because plan slugs
 * are long (`hud-session-launcher-and-board-tabs-2026-07-26` is 44 chars) and
 * numerous — a chip per plan would wrap the filter row several times deep on a
 * narrow HUD rail. D-002 anticipated exactly this: the P-003 Combobox was built
 * "deliberately generic so P-004 (plan filter) … reuse[s] it rather than
 * growing more bespoke pickers". Behaviour still mirrors the fleet filter: the
 * options are derived from what is in view, each carries its count and the same
 * one-line health note, and there is an always-present row that clears it.
 */
function planFilterOptions(plans: HudBoardData['plans']): ComboboxOption[] {
  const inView = plans.reduce((n, p) => n + p.total, 0);
  return [
    {
      value: ALL_PLANS,
      label: 'All plans',
      // `board.total` would be the POST-filter count and would read as "1
      // session" while the list beneath it offers nine. Sum the rollups, which
      // are pre-filter by construction (see buildHudBoard).
      detail: `${inView} session${inView === 1 ? '' : 's'} in view`,
    },
    ...plans.map((p): ComboboxOption => ({
      value: p.planSlug ?? NO_PLAN_TOKEN,
      label: p.label,
      detail: `${p.total} session${p.total === 1 ? '' : 's'}${p.warning ? ` · ${p.warning}` : ''}`,
      // A human half-remembers "the HUD plan" or "hud tabs", not the date
      // suffix; cmdk scores keywords equally with the label.
      keywords: p.planSlug ? p.planSlug.split('-') : ['unbound', 'no plan'],
    })),
  ];
}

export default function HudBoard({
  board,
  selectedFleets,
  onToggleFleet,
  selectedPlans,
  onSelectPlan,
  focusColumn,
  onFocusColumn,
  suOnly,
  onToggleSuOnly,
  onOpenSession,
  loading,
  error,
  headerAction,
  sessionQuery = '',
  onSessionQuery,
  searchActive = false,
  tab,
  onSelectTab,
  entityView,
}: HudBoardProps) {
  const needsYou = board.counts['needs-you'];
  const unattributedCount = board.unattributed.length;
  const visibleColumns = focusColumn
    ? board.columns.filter((c) => c.id === focusColumn)
    : board.columns;
  const onSessions = tab === 'sessions';

  const planOptions = useMemo(() => planFilterOptions(board.plans), [board.plans]);
  /* The control is single-select, so it shows the first selection; `ALL_PLANS`
     is the Combobox's `emptyValue`, which makes the box render its placeholder
     rather than the row's label while nothing is filtered. */
  const planValue = selectedPlans.length === 0
    ? ALL_PLANS
    : (selectedPlans[0] ?? NO_PLAN_TOKEN);

  return (
    <div className="hud">
      {/* The tab strip owns its own row above the controls, not a slot inside
          them: the controls BELONG to a tab (fleet chips are a session idea),
          so nesting the switch among the things it switches would read as a
          sibling filter rather than the axis it is. */}
      <div className="hud__tabs">
        {/* The launcher stays OUTSIDE the tab bodies: launching a session is
            not a thing you do to the sessions board, it is a thing you do from
            the HUD, and hiding it behind a tab would make it unreachable from
            the two tabs most likely to make you want it. It has moved through
            this strip over several owner asks — far right behind a spacer, then
            after the tabs, then ahead of them — and now sits on its OWN row
            just below (see .hud__launchrow, rendered after this strip).

            It is also kept OUT of the `role="tablist"` element: that role must
            contain only tabs, and parking a launch button (three comboboxes and
            a submit) inside one misreports the strip to a screen reader as a
            four-tab axis. The tablist role sits on the inner wrapper holding
            exactly the tabs. */}
        <div className="hud__tablist" role="tablist" aria-label="HUD board">
          {HUD_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={`hud__tab${tab === id ? ' hud__tab--on' : ''}`}
              aria-selected={tab === id}
              onClick={() => onSelectTab(id)}
            >
              <span className="hud__tab-row">{HUD_TAB_LABEL[id]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Owner ask 2026-07-27 (asked several times, and my two previous passes
          misread it): "move the select plan / model / effort / new session
          buttons to the row below". I had twice rearranged the controls WITHIN
          the launcher while it stayed on the tab strip's row — but the row being
          referred to is the TAB STRIP's. So the launcher now owns a row of its
          own, directly BELOW the tabs, with all four controls on that one line.

          It is a sibling of .hud__tabs rather than a child because .hud__tabs
          has padding-bottom:0 + align-items:flex-end + a bottom border so the
          selected tab can BRIDGE that border (.hud__tab--on). Nesting a second
          line inside it would put the launcher underneath that border and break
          the bridge; a separate row keeps the tab chrome intact. */}
      {headerAction ? <div className="hud__launchrow">{headerAction}</div> : null}

      {!onSessions ? (
        entityView ?? null
      ) : (
      <>
      <div className="hud__top">
        {/* P-002 (owner asks 2026-07-26) put the launch cluster at the head of
            this row, ahead of the count chips. P-009 lifted it one level, into
            the tab strip above — it is a HUD-wide control, not a sessions-board
            one, and leaving it here would have made it vanish on the Plans and
            Work items tabs. The ordering the owner asked for is preserved: the
            launcher still leads, the counts still follow. */}
        {/* Owner ask 2026-07-27: "move the plan filter as the first filter
            before all agents". It previously sat at the END of this row, past a
            flex:1 .hud__spacer that right-aligned it — so on a wide board it was
            a screen-width away from the other filters it belongs with. It now
            LEADS the row, ahead of the su-only/all-agents toggle.

            Keeping it in .hud__top (not down in .hud__fleets) still matters for
            the original reason: .hud__fleets is nowrap + overflow-x:auto, so a
            picker appended there is reachable only by scrolling past every fleet
            chip (verified live 2026-07-26 — with 14 fleets it was entirely off
            screen). .hud__top wraps, so this stays visible at any width.

            `align="end"` is dropped with the right-alignment that motivated it:
            a leading control should open flush with its own left edge. */}
        {board.plans.length > 0 ? (
          <span className="hud__planfilter">
            <Combobox
              ariaLabel="Filter by plan"
              triggerClassName="hud__planfilter-box"
              testId="hud-plan-filter"
              value={planValue}
              emptyValue={ALL_PLANS}
              placeholder="All plans"
              emptyLabel="No plan matches"
              options={planOptions}
              onChange={(v) => onSelectPlan(v === NO_PLAN_TOKEN ? null : v)}
            />
          </span>
        ) : null}

        <Tooltip
          label={
            suOnly
              ? 'Currently showing your su sessions only. Include nursery cups and autonomous agents too.'
              : 'Currently showing every agent on the roster. Narrow back to your su sessions.'
          }
        >
          <button
            type="button"
            className="hud__count"
            aria-pressed={!suOnly}
            onClick={onToggleSuOnly}
          >
            <span className="hud__count-row">{suOnly ? 'su sessions' : 'all agents'}</span>
          </button>
        </Tooltip>

        <div className="hud__counts">
          {board.columns.map((c) => {
            const hot = c.id === 'needs-you' && c.sessions.length > 0;
            return (
              <Tooltip key={c.id} label={`Show only ${c.label}`}>
                <button
                  type="button"
                  className={`hud__count${hot ? ' hud__count--hot' : ''}`}
                  aria-pressed={focusColumn === c.id}
                  onClick={() => onFocusColumn(focusColumn === c.id ? null : c.id)}
                >
                  {/* Flex row on the inner span — see the WebKitGTK note on
                      .hud__count in hud.css. */}
                  <span className="hud__count-row">
                    <b>{c.sessions.length}</b> {c.label.toLowerCase()}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/* Searches every session's FULL TRANSCRIPT, not the card text — the
            roster carries only metadata, so "which session was I debugging the
            gym gate in" is unanswerable from the board itself. In this row (not
            .hud__fleets) for the same nowrap/overflow reason documented on the
            plan filter, which now leads the row. */}
        {onSessionQuery ? (
          <input
            type="search"
            className="hud__search"
            value={sessionQuery}
            placeholder="Search transcripts…"
            aria-label="Search session transcripts"
            data-testid="hud-session-search"
            onChange={(e) => onSessionQuery(e.target.value)}
          />
        ) : null}

      </div>

      {board.fleets.length > 0 ? (
        <div className="hud__fleets">
          <Tooltip label="Show every fleet">
            <button
              type="button"
              className="hud__fleet"
              aria-pressed={selectedFleets.length === 0}
              onClick={() => onToggleFleet(ALL_FLEETS)}
            >
              <span className="hud__fleet-row">
                <span>all fleets</span>
                <span className="hud__fleet-n">{board.total}</span>
              </span>
            </button>
          </Tooltip>
          {board.fleets.map((f) => (
            <FleetChip
              key={f.fleetSlug ?? SOLO_FLEET_KEY}
              fleet={f}
              selected={selectedFleets.includes(f.fleetSlug)}
              onToggle={onToggleFleet}
            />
          ))}
        </div>
      ) : null}

      {/* The unattributed-ask strip that used to sit here now renders inside
          the Work items tab — see the note where UnattributedAskCard was. A
          pointer stays on the sessions board so the count is never simply
          gone: an ask nobody can see is the failure P-002 existed to prevent. */}
      {unattributedCount > 0 ? (
        <p className="hud__nudge">
          <button type="button" className="hud__count hud__count--hot" onClick={() => onSelectTab('items')}>
            <span className="hud__count-row">
              <b>{unattributedCount}</b> unattributed ask{unattributedCount === 1 ? '' : 's'} — open Work items
            </span>
          </button>
        </p>
      ) : null}

      {error ? (
        <p className="hud__state hud__state--error">
          Could not read the session roster: {error}
        </p>
      ) : loading && board.total === 0 ? (
        <p className="hud__state">Reading the session roster…</p>
      ) : board.total === 0 ? (
        <p className="hud__state">
          {/* A search that matched nothing must NOT render as "no sessions are
              running" — that reads as an empty roster and sends you looking for
              a launch bug instead of clearing the filter. */}
          {searchActive
            ? 'No session transcript matched that search. Sessions whose history has not been indexed yet will not appear — clear the search to see the full board.'
            : suOnly
              ? 'No su sessions are running. Launch one with the psu command, or from the New session button — either way it appears here.'
              : 'No agents on the roster.'}
        </p>
      ) : (
        <div className="hud__cols" style={focusColumn ? { gridTemplateColumns: '1fr' } : undefined}>
          {visibleColumns.map((c) => (
            <section key={c.id} className={`hud__col hud__col--${c.id}`} aria-label={c.label}>
              <h3 className="hud__col-h">
                {c.label}
                <span className="n">{c.sessions.length}</span>
              </h3>
              <div className="hud__col-b">
                {c.sessions.length === 0 ? (
                  <p className="hud__empty">{c.empty}</p>
                ) : (
                  c.sessions.map((s) => (
                    <MemoSessionCard key={s.ownerId} session={s} onOpen={onOpenSession} />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Screen-reader summary: the counts are the point of the board, and a
          five-column grid does not convey them linearly. */}
      <p className="sr-only" role="status">
        {needsYou > 0
          ? `${needsYou} session${needsYou === 1 ? '' : 's'} waiting on you.`
          : 'Nothing is waiting on you.'}
        {unattributedCount > 0
          ? ` ${unattributedCount} unattributed ask${unattributedCount === 1 ? '' : 's'} with no owning session, on the Work items tab.`
          : ''}
      </p>
      </>
      )}
    </div>
  );
}
