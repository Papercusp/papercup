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

import { memo, type ReactNode } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';
import FleetRoleGlyph from '@/app/_components/FleetRoleGlyph';
import {
  ALL_FLEETS,
  SOLO_FLEET_KEY,
  formatAge,
  HUD_ASK_KIND_LABEL,
  type HudAsk,
  type HudBoard as HudBoardData,
  type HudBadge,
  type HudColumnId,
  type HudFleetRollup,
  type HudSession,
} from './hud-board-model';
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

/**
 * UnattributedAsk — a needs-human Decision with no `ownerAgentId` to key a
 * session card off of (hud-consolidation-2026-07-26 P-002, the coverage gate
 * that must pass before the sidebar Inbox can be retired). Deliberately NOT a
 * `<button>`/`onOpen` like SessionCard: there is no live agent session to
 * open a conversation with, so this renders as an informational card — kind
 * badge + title + age — rather than pretending an activation target exists.
 * A `planSlug`/`itemRef` are carried on the underlying HudAsk for a FUTURE
 * caller that wants to wire a destination (mirrors chat-ref-pills-2026-07-26's
 * D-002 seam: rendering and destination are separable concerns), but wiring
 * one is explicitly out of scope for this gate — the gate is about
 * VISIBILITY, not click-through parity with the Inbox.
 */
function UnattributedAskCard({ ask }: { ask: HudAsk }) {
  const kindLabel = HUD_ASK_KIND_LABEL[ask.kind] ?? ask.kind;
  return (
    <div className="hud__card hud__card--unattributed" aria-label={`${kindLabel} — ${ask.title}`}>
      <span className="hud__card-row">
        <span className="hud__rail" aria-hidden="true" />
        <span className="hud__card-b">
          <span className="hud__card-h">
            <span className="hud__dot hud__dot--needs-you" aria-hidden="true" />
            <span className="hud__chip hud__chip--accent">{kindLabel}</span>
            <span className="hud__age">{formatAge(ageSecFromIso(ask.occurredAt))}</span>
          </span>
          <span className="hud__reason">{ask.title}</span>
          {ask.planSlug ? <span className="hud__plan">{ask.planSlug}</span> : null}
        </span>
      </span>
    </div>
  );
}

const MemoUnattributedAskCard = memo(UnattributedAskCard);

/** Local mirror of hud-board-model's private `ageSec` — that one is not
 *  exported (it takes an injected `nowMs`, which this presentational card has
 *  no reason to thread through props for a once-per-render age label). */
function ageSecFromIso(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

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
}: HudBoardProps) {
  const needsYou = board.counts['needs-you'];
  const unattributedCount = board.unattributed.length;
  const visibleColumns = focusColumn
    ? board.columns.filter((c) => c.id === focusColumn)
    : board.columns;

  return (
    <div className="hud">
      <div className="hud__top">
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

        {headerAction ? <span className="hud__header-action">{headerAction}</span> : null}

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

        {/* P-002 (owner ask 2026-07-26: "left align these buttons instead of
            right align"). The spacer used to sit BEFORE the header action,
            which is what pushed the launcher cluster + the su-sessions toggle
            to the far right. Trailing it instead left-aligns the whole row and
            lets the slack fall on the right. */}
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

      {/* hud-consolidation-2026-07-26 P-002: needs-human Decisions with no
          owning agent (an unclaimed needs-human plan/work item, an
          improvement/standing-approval/dark-flag awaiting triage, …) render
          here rather than nowhere — see UnattributedAskCard's doc. */}
      {board.unattributed.length > 0 ? (
        <section className="hud__unattributed" aria-label="Unattributed asks">
          <h3 className="hud__col-h">
            Needs you — unattributed
            <span className="n">{board.unattributed.length}</span>
          </h3>
          <div className="hud__unattributed-b">
            {board.unattributed.map((a) => (
              <MemoUnattributedAskCard key={a.id} ask={a} />
            ))}
          </div>
        </section>
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
          ? ` ${unattributedCount} unattributed ask${unattributedCount === 1 ? '' : 's'} with no owning session.`
          : ''}
      </p>
    </div>
  );
}
