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

export default function HudBoard({
  board,
  selectedFleets,
  onToggleFleet,
  focusColumn,
  onFocusColumn,
  suOnly,
  onToggleSuOnly,
  onOpenSession,
  loading,
  error,
  headerAction,
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

  return (
    <div className="hud">
      {/* The tab strip owns its own row above the controls, not a slot inside
          them: the controls BELONG to a tab (fleet chips are a session idea),
          so nesting the switch among the things it switches would read as a
          sibling filter rather than the axis it is. */}
      <div className="hud__tabs" role="tablist" aria-label="HUD board">
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
        <span className="hud__spacer" />
        {/* The launcher stays OUTSIDE the tab bodies: launching a session is
            not a thing you do to the sessions board, it is a thing you do from
            the HUD, and hiding it behind a tab would make it unreachable from
            the two tabs most likely to make you want it. */}
        {headerAction ? <span className="hud__header-action">{headerAction}</span> : null}
      </div>

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

        <span className="hud__spacer" />
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
          {suOnly
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
