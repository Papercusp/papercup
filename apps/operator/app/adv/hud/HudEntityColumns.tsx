'use client';

/**
 * HudEntityColumns — the presentational half of the HUD's Plans and Work items
 * tabs (hud-session-launcher-and-board-tabs-2026-07-26 P-009).
 *
 * Same contract as HudBoard.tsx: this file renders, it does not decide. Every
 * column, badge and count arrives already computed from `hud-entity-board.ts`.
 *
 * It reuses the session board's CLASS NAMES wholesale (`hud__cols`, `hud__col`,
 * `hud__card`, `hud__chip`, …) rather than defining a parallel set, because the
 * owner's ask was explicitly "the same kanban style" — a second set of styles
 * would be a promise to keep them looking identical forever, by hand. The only
 * new CSS this tab needs is the tab strip itself and the search box.
 *
 * Cards are `<div>`s, not `<button>`s. A session card opens that session's live
 * transcript; a plan or work-item card has no equivalent destination wired yet,
 * and a button that looks activatable but does nothing is worse than a card
 * that never claimed to be. The destination is a deliberate future seam (the
 * card model already carries `id`/`ref`), the same separation
 * `UnattributedAskCard` documents in HudBoard.tsx.
 */

import { memo } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';
import { formatAge, type HudBadge } from './hud-board-model';
import {
  HUD_ENTITY_COLUMNS,
  HUD_ENTITY_COLUMN_LABEL,
  type HudEntityBoard,
  type HudEntityCard,
  type HudEntityColumnId,
} from './hud-entity-board';

const CHIP_TONE_CLASS: Record<HudBadge['tone'], string> = {
  neutral: '',
  accent: 'hud__chip--accent',
  good: 'hud__chip--good',
  warn: 'hud__chip--warn',
  bad: 'hud__chip--bad',
};

/** Same cap the session card applies — a card with eight chips communicates
 *  less than one with four, and the model already orders them by value. */
const MAX_CHIPS = 4;

function EntityCard({ card }: { card: HudEntityCard }) {
  const chips = card.badges.slice(0, MAX_CHIPS);
  const overflow = card.badges.length - chips.length;
  return (
    <div
      className={`hud__card hud__card--${card.column} hud__card--entity`}
      aria-label={`${card.ref} — ${card.title}`}
    >
      {/* Flex row on the inner span, never the outer element — see the
          WebKitGTK note on .hud__card in hud.css. */}
      <span className="hud__card-row">
        <span className="hud__rail" aria-hidden="true" />
        <span className="hud__card-b">
          <span className="hud__card-h">
            <span className={`hud__dot hud__dot--${card.column}`} aria-hidden="true" />
            <span className="hud__handle">{card.ref}</span>
            <span className="hud__age">{formatAge(card.sinceSec)}</span>
          </span>

          <span className="hud__reason">{card.title}</span>

          {/* The "why" line sits BELOW the title here, inverting the session
              card (where the reason IS the content and there is no separate
              title). A plan's title is the thing you scan for; its next-action
              is the detail you read once you have found it. */}
          {card.reason ? <span className="hud__entity-why">{card.reason}</span> : null}

          {card.context ? <span className="hud__plan">{card.context}</span> : null}

          {chips.length > 0 ? (
            <span className="hud__chips">
              {chips.map((b) =>
                b.title ? (
                  <Tooltip key={b.id} label={b.title}>
                    <span className={`hud__chip ${CHIP_TONE_CLASS[b.tone]}`}>{b.label}</span>
                  </Tooltip>
                ) : (
                  <span key={b.id} className={`hud__chip ${CHIP_TONE_CLASS[b.tone]}`}>
                    {b.label}
                  </span>
                ),
              )}
              {overflow > 0 ? <span className="hud__chip">+{overflow}</span> : null}
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

const MemoEntityCard = memo(EntityCard);

export interface HudEntityColumnsProps {
  board: HudEntityBoard;
  /** Column filter — when set, only this column is shown, expanded. */
  focusColumn: HudEntityColumnId | null;
  onFocusColumn: (id: HudEntityColumnId | null) => void;
  query: string;
  onQuery: (q: string) => void;
  loading: boolean;
  error: string | null;
  /** Shown when the board is genuinely empty (not loading, not filtered). */
  emptyLabel: string;
  /** Noun for the search placeholder + filtered-empty message ("plans"). */
  noun: string;
}

export default function HudEntityColumns({
  board,
  focusColumn,
  onFocusColumn,
  query,
  onQuery,
  loading,
  error,
  emptyLabel,
  noun,
}: HudEntityColumnsProps) {
  const visibleColumns = focusColumn
    ? board.columns.filter((c) => c.id === focusColumn)
    : board.columns;

  return (
    <>
      <div className="hud__top hud__top--entity">
        <div className="hud__counts">
          {HUD_ENTITY_COLUMNS.map((id) => {
            const n = board.counts[id];
            const hot = id === 'needs-you' && n > 0;
            return (
              <Tooltip key={id} label={`Show only ${HUD_ENTITY_COLUMN_LABEL[id]}`}>
                <button
                  type="button"
                  className={`hud__count${hot ? ' hud__count--hot' : ''}`}
                  aria-pressed={focusColumn === id}
                  onClick={() => onFocusColumn(focusColumn === id ? null : id)}
                >
                  <span className="hud__count-row">
                    <b>{n}</b> {HUD_ENTITY_COLUMN_LABEL[id].toLowerCase()}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/* A workspace this size carries ~900 plans and ~1800 work items, so
            search is not a nicety — without it the board is a wall. It filters
            the MODEL (ref/title/context), so the counts above always describe
            what is actually on screen. */}
        <input
          type="search"
          className="hud__search"
          value={query}
          placeholder={`Filter ${noun}…`}
          aria-label={`Filter ${noun}`}
          onChange={(e) => onQuery(e.target.value)}
        />

        <span className="hud__spacer" />
      </div>

      {error ? (
        <p className="hud__state hud__state--error">Could not read {noun}: {error}</p>
      ) : loading && board.total === 0 ? (
        <p className="hud__state">Reading {noun}…</p>
      ) : board.total === 0 ? (
        <p className="hud__state">{query.trim() ? `No ${noun} match “${query.trim()}”.` : emptyLabel}</p>
      ) : (
        <div className="hud__cols" style={focusColumn ? { gridTemplateColumns: '1fr' } : undefined}>
          {visibleColumns.map((c) => (
            <section key={c.id} className={`hud__col hud__col--${c.id}`} aria-label={c.label}>
              <h3 className="hud__col-h">
                {c.label}
                <span className="n">{board.counts[c.id]}</span>
              </h3>
              <div className="hud__col-b">
                {c.cards.length === 0 ? (
                  <p className="hud__empty">{c.empty}</p>
                ) : (
                  <>
                    {c.cards.map((card) => (
                      <MemoEntityCard key={card.id} card={card} />
                    ))}
                    {/* A truncated column says so. The cap is a render bound;
                        pretending the column holds 60 items when it holds 400
                        would make every count on this board suspect. */}
                    {c.hidden > 0 ? (
                      <p className="hud__empty hud__more">+{c.hidden} more — narrow with the filter</p>
                    ) : null}
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
