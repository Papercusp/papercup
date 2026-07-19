/**
 * CardStack — a reusable "peek stack + prev/next" browser for a group of
 * same-type cards (owner ask 2026-07-19: "stack cards of the same type so that
 * they overlap, and then give a way for the user to navigate through them").
 *
 * The interaction (owner-confirmed 2026-07-19, refined for legibility): the
 * active card sits front-and-centre, lifted off the pile; the PREVIOUS card
 * peeks out on the left and the NEXT card(s) pile on the right — each peek is a
 * clickable, chevron-marked card edge, so it reads as a real deck you flip. A
 * prominent Prev / Next bar (with ← → keys when the deck is focused) plus
 * clickable position dots (for ≤12 cards) drive it; clicking any peek jumps
 * straight to that card. An optional expand toggle swaps the active card for a
 * fuller detail body.
 *
 * Dependency-free on purpose — the peek + step interaction needs only CSS
 * transforms/transitions, not a swipe-physics library (build-vs-buy research
 * 2026-07-19: the Tinder-style decks are mobile-swipe-first and heavier than
 * this desktop browse case; framer-motion is unused in the tree and not needed
 * here). Self-styled in the panel idiom (scoped `pc-cardstack__*`) so it drops
 * into both operator (Next) and operator-vite consumers via `@/app/harness`.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

export interface CardStackProps<T> {
  /** The same-type cards to stack, in the order they should be browsed. */
  items: readonly T[];
  /** Stable key per item (drives the cross-fade on step). */
  getKey: (item: T, index: number) => string;
  /** The collapsed/top-card content for one item. */
  renderCard: (item: T, index: number) => ReactNode;
  /** Optional fuller body shown when the top card is expanded. Omit ⇒ no expand control. */
  renderExpanded?: (item: T, index: number) => ReactNode;
  /** Accessible label for the deck region. */
  ariaLabel?: string;
  /** Extra class on the outer wrapper. */
  className?: string;
  /** How many ghost layers to imply behind the top card (default 2). */
  maxPeek?: number;
}

export function CardStack<T>({
  items,
  getKey,
  renderCard,
  renderExpanded,
  ariaLabel,
  className,
  maxPeek = 2,
}: CardStackProps<T>) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const deckRef = useRef<HTMLDivElement>(null);

  const count = items.length;
  // Clamp defensively — `items` can shrink under the cursor on a re-fetch.
  const active = Math.min(index, Math.max(0, count - 1));
  useEffect(() => {
    if (index !== active) setIndex(active);
  }, [index, active]);
  // Collapse the expanded body whenever the cursor moves to another card.
  useEffect(() => {
    setExpanded(false);
  }, [active]);

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = Math.min(count - 1, Math.max(0, i + delta));
        return next;
      });
    },
    [count],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        step(1);
      }
    },
    [step],
  );

  if (count === 0) return null;

  const item = items[active];
  const key = getKey(item, active);
  const canExpand = Boolean(renderExpanded);
  // Next cards peeking on the RIGHT (a small pile ⇒ "more ahead"); the previous
  // card peeks on the LEFT. Furthest-first in the DOM so the nearest paints on
  // top. All peeks are clickable to jump straight to that card.
  const nextPeeks: number[] = [];
  for (let d = 1; d <= maxPeek && active + d <= count - 1; d++) {
    nextPeeks.push(active + d);
  }
  nextPeeks.reverse();
  const dots = count <= 12;

  return (
    <div className={`pc-cardstack${className ? ` ${className}` : ""}`}>
      <div
        ref={deckRef}
        className="pc-cardstack__deck"
        role="group"
        aria-label={ariaLabel ?? `Card ${active + 1} of ${count}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {/* Previous card, peeking on the left — click to go back. */}
        {active > 0 ? (
          <button
            type="button"
            className="pc-cardstack__peek pc-cardstack__peek--prev"
            aria-hidden
            tabIndex={-1}
            title="Previous card"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
        ) : null}

        {/* Next cards, piled on the right — click to jump forward. */}
        {nextPeeks.map((idx) => {
          const depth = idx - active; // 1..maxPeek
          return (
            <button
              key={`next-${idx}`}
              type="button"
              className="pc-cardstack__peek pc-cardstack__peek--next"
              data-depth={depth}
              aria-hidden
              tabIndex={-1}
              title="Next card"
              onClick={() => setIndex(idx)}
            >
              {depth === 1 ? <ChevronRight size={16} aria-hidden /> : null}
            </button>
          );
        })}

        <div
          key={key}
          className={`pc-cardstack__top${expanded ? " is-expanded" : ""}`}
        >
          {expanded && renderExpanded
            ? renderExpanded(item, active)
            : renderCard(item, active)}
        </div>
      </div>

      <div className="pc-cardstack__nav">
        <button
          type="button"
          className="pc-cardstack__arrow"
          aria-label="Previous card"
          disabled={active === 0}
          onClick={() => step(-1)}
        >
          <ChevronLeft size={15} aria-hidden />
          <span>Prev</span>
        </button>

        {dots ? (
          <div
            className="pc-cardstack__dots"
            role="tablist"
            aria-label={`Card ${active + 1} of ${count}`}
          >
            {items.map((it, i) => (
              <button
                key={getKey(it, i)}
                type="button"
                role="tab"
                aria-selected={i === active}
                aria-label={`Go to card ${i + 1} of ${count}`}
                className={`pc-cardstack__dot${i === active ? " is-active" : ""}`}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        ) : (
          <span
            className="pc-cardstack__count"
            aria-live="polite"
            aria-label={`Card ${active + 1} of ${count}`}
          >
            {active + 1} <i>of</i> {count}
          </span>
        )}

        <button
          type="button"
          className="pc-cardstack__arrow"
          aria-label="Next card"
          disabled={active >= count - 1}
          onClick={() => step(1)}
        >
          <span>Next</span>
          <ChevronRight size={15} aria-hidden />
        </button>
        {canExpand ? (
          <button
            type="button"
            className="pc-cardstack__expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </div>

      <style>{`
      .pc-cardstack { display: flex; flex-direction: column; gap: 8px; }
      /* Horizontal gutters give the side peeks room to show; the active card
         fills the middle and sits ON TOP so the deck reads as a stack you flip. */
      .pc-cardstack__deck {
        position: relative; outline: none; border-radius: 12px;
        padding: 6px 30px;
      }
      .pc-cardstack__deck:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #7dd3fc) 55%, transparent); }
      /* A peek = the edge of an adjacent card sticking out from behind the
         active one. Clickable, chevron-marked, so moving left/right is obvious. */
      .pc-cardstack__peek {
        position: absolute; top: 14px; bottom: 14px; width: 52px;
        display: flex; align-items: center; padding: 0; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
        color: var(--fg-mute, #7f9bb4);
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.28);
        transition: transform 150ms ease, opacity 150ms ease, color 150ms ease, background 150ms ease;
      }
      .pc-cardstack__peek:hover { color: var(--fg, #e7eef5); background: color-mix(in srgb, var(--accent, #7dd3fc) 12%, var(--bg-2)); }
      .pc-cardstack__peek--prev {
        left: 2px; z-index: 1; justify-content: flex-start; padding-left: 4px;
        border-radius: 10px 4px 4px 10px;
      }
      .pc-cardstack__peek--prev:hover { transform: translateX(-3px); }
      .pc-cardstack__peek--next {
        right: 2px; justify-content: flex-end; padding-right: 4px;
        border-radius: 4px 10px 10px 4px;
      }
      .pc-cardstack__peek--next:hover { transform: translateX(3px); }
      .pc-cardstack__peek--next[data-depth="1"] { z-index: 2; opacity: 0.95; }
      .pc-cardstack__peek--next[data-depth="2"] { z-index: 1; right: -6px; top: 20px; bottom: 20px; opacity: 0.6; }
      .pc-cardstack__peek--next[data-depth="3"] { z-index: 0; right: -13px; top: 26px; bottom: 26px; opacity: 0.4; }
      /* The active card: front and centre, lifted off the pile with a shadow. */
      .pc-cardstack__top {
        position: relative; z-index: 3;
        border-radius: 11px;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
        animation: pc-cardstack-in 170ms ease;
      }
      @keyframes pc-cardstack-in {
        from { opacity: 0; transform: translateY(4px) scale(0.985); }
        to { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .pc-cardstack__top { animation: none; }
        .pc-cardstack__peek { transition: none; }
      }
      .pc-cardstack__nav {
        display: flex; align-items: center; gap: 8px; padding-inline: 2px;
      }
      .pc-cardstack__arrow {
        display: inline-flex; align-items: center; gap: 3px;
        height: 26px; padding: 0 10px 0 8px; border-radius: 8px; cursor: pointer;
        font: inherit; font-size: 11px; font-weight: 600;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.24));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-cardstack__arrow:last-of-type { padding: 0 8px 0 10px; }
      .pc-cardstack__arrow:hover:not(:disabled) {
        color: var(--fg, #e7eef5);
        border-color: color-mix(in srgb, var(--accent, #7dd3fc) 50%, var(--border));
        background: color-mix(in srgb, var(--accent, #7dd3fc) 10%, var(--bg-2));
      }
      .pc-cardstack__arrow:disabled { opacity: 0.32; cursor: default; }
      .pc-cardstack__count {
        font-size: 11px; font-variant-numeric: tabular-nums; color: var(--fg-dim, #b9d4e8);
        min-width: 56px; text-align: center;
      }
      .pc-cardstack__count i { font-style: normal; color: var(--fg-mute, #7f9bb4); }
      .pc-cardstack__dots {
        display: flex; align-items: center; gap: 6px; flex: 1 1 auto; justify-content: center;
      }
      .pc-cardstack__dot {
        width: 9px; height: 9px; padding: 0; border-radius: 50%; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.35));
        background: transparent; transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }
      .pc-cardstack__dot:hover { border-color: color-mix(in srgb, var(--accent, #7dd3fc) 60%, var(--border)); }
      .pc-cardstack__dot.is-active {
        background: var(--accent, #7dd3fc);
        border-color: var(--accent, #7dd3fc);
        transform: scale(1.15);
      }
      .pc-cardstack__expand {
        margin-left: auto; padding: 3px 10px; border-radius: 999px; cursor: pointer;
        font-size: 10.5px; font-weight: 600;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: none; color: var(--fg-mute, #7f9bb4);
      }
      .pc-cardstack__expand:hover {
        color: var(--fg-dim, #b9d4e8);
        border-color: color-mix(in srgb, var(--accent, #7dd3fc) 45%, var(--border));
      }
      `}</style>
    </div>
  );
}
