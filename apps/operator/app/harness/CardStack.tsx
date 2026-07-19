/**
 * CardStack — a reusable "peek stack + prev/next" browser for a group of
 * same-type cards (owner ask 2026-07-19: "stack cards of the same type so that
 * they overlap, and then give a way for the user to navigate through them").
 *
 * The chosen interaction (owner-confirmed 2026-07-19): the top card renders in
 * full; up to two cards BEHIND it are implied as offset/scaled ghost layers so
 * the stack's depth reads at a glance; a `‹ n of N ›` control (plus ← → keys
 * when the deck is focused) cycles the top card; an optional expand toggle
 * swaps the top card for a fuller detail body.
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
  // Ghost layers = cards still below the top one, capped at maxPeek. At the
  // bottom of the stack no ghosts render, so the deck visibly thins out.
  const ghosts = Math.min(maxPeek, count - 1 - active);
  const canExpand = Boolean(renderExpanded);

  return (
    <div className={`pc-cardstack${className ? ` ${className}` : ""}`}>
      <div
        ref={deckRef}
        className="pc-cardstack__deck"
        role="group"
        aria-label={ariaLabel ?? `Card ${active + 1} of ${count}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        // A little breathing room on top/right so the ghost layers are visible.
        style={{ paddingTop: ghosts * 6, paddingRight: ghosts * 6 }}
      >
        {Array.from({ length: ghosts }, (_, g) => {
          const depth = g + 1; // 1..ghosts
          return (
            <div
              key={`ghost-${depth}`}
              className="pc-cardstack__ghost"
              aria-hidden
              style={{
                transform: `translate(${depth * 6}px, -${depth * 6}px) scale(${1 - depth * 0.03})`,
                opacity: 0.5 - (depth - 1) * 0.16,
                zIndex: 1,
              }}
            />
          );
        })}
        <div
          key={key}
          className={`pc-cardstack__top${expanded ? " is-expanded" : ""}`}
          style={{ zIndex: 2 }}
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
          ‹
        </button>
        <span
          className="pc-cardstack__count"
          aria-live="polite"
          aria-label={`Card ${active + 1} of ${count}`}
        >
          {active + 1} <i>of</i> {count}
        </span>
        <button
          type="button"
          className="pc-cardstack__arrow"
          aria-label="Next card"
          disabled={active >= count - 1}
          onClick={() => step(1)}
        >
          ›
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
      .pc-cardstack { display: flex; flex-direction: column; gap: 6px; }
      .pc-cardstack__deck {
        position: relative; outline: none; border-radius: 10px;
      }
      .pc-cardstack__deck:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #7dd3fc) 55%, transparent); }
      .pc-cardstack__ghost {
        position: absolute; inset: 0; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
        transform-origin: top right;
        pointer-events: none;
        transition: transform 180ms ease, opacity 180ms ease;
      }
      .pc-cardstack__top {
        position: relative;
        animation: pc-cardstack-in 180ms ease;
      }
      @keyframes pc-cardstack-in {
        from { opacity: 0; transform: translateY(4px) scale(0.985); }
        to { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .pc-cardstack__top { animation: none; }
        .pc-cardstack__ghost { transition: none; }
      }
      .pc-cardstack__nav {
        display: flex; align-items: center; gap: 8px; padding-inline: 2px;
      }
      .pc-cardstack__arrow {
        display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; border-radius: 7px; cursor: pointer;
        font-size: 16px; line-height: 1; padding: 0;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-cardstack__arrow:hover:not(:disabled) {
        color: var(--fg, #e7eef5);
        border-color: color-mix(in srgb, var(--accent, #7dd3fc) 45%, var(--border));
      }
      .pc-cardstack__arrow:disabled { opacity: 0.35; cursor: default; }
      .pc-cardstack__count {
        font-size: 11px; font-variant-numeric: tabular-nums; color: var(--fg-dim, #b9d4e8);
        min-width: 56px; text-align: center;
      }
      .pc-cardstack__count i { font-style: normal; color: var(--fg-mute, #7f9bb4); }
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
