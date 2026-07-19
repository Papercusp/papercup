/**
 * CardStack — a reusable overlapping-deck browser for a group of same-type
 * cards (owner ask 2026-07-19: "stack cards of the same type so that they
 * overlap, and then give a way for the user to navigate through them").
 *
 * The design (owner-refined 2026-07-19, 3rd pass):
 *   - Cards behind the active one are stacked DOWN-AND-RIGHT (each a little
 *     right of + below the one above), so the pile reads as a physical deck.
 *     Clicking a stacked card jumps straight to it.
 *   - Cycling animates the classic index-based deck pattern (the approach the
 *     Motion/Framer card-stack example uses): every card's transform derives
 *     from its distance to the active index; stepping NEXT flies the top card
 *     off to the left with a tilt + fade while the next card slides up out of
 *     the pile; stepping PREV flies it back on. Pure CSS transitions — same
 *     technique, no animation dependency (interaction is click/keys, not drag).
 *   - Navigation is ON the card: "‹ Prev" / "Next ›" pills straddling the
 *     card's bottom edge (no separate nav row below), plus ← → keys when the
 *     deck is focused.
 *   - The position indicator sits ABOVE the card: story-style dots where the
 *     active dot stretches into an accent pill (a plain `n of N` for decks of
 *     more than 12).
 *   - The optional `header` (category label + count) renders as a badge
 *     overlapping the active card's TOP edge, so it is visibly attached to the
 *     card it describes.
 *
 * Self-styled in the panel idiom (scoped `pc-cardstack__*`) so it drops into
 * both operator (Next) and operator-vite consumers via `@/app/harness`.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

export interface CardStackProps<T> {
  /** The same-type cards to stack, in the order they should be browsed. */
  items: readonly T[];
  /** Stable key per item (drives the deck transition on step). */
  getKey: (item: T, index: number) => string;
  /** The card content for one item (rendered on the ACTIVE card only —
   *  stacked cards behind it render as card backs). */
  renderCard: (item: T, index: number) => ReactNode;
  /** Optional fuller body shown when the active card is expanded. Omit ⇒ no expand control. */
  renderExpanded?: (item: T, index: number) => ReactNode;
  /** Category badge content (label + count) rendered overlapping the active
   *  card's top edge — visibly attached to the card it describes. Use the
   *  `pc-cardstack__header-label` / `pc-cardstack__header-count` classes for
   *  consistent typography. */
  header?: ReactNode;
  /** Accessible label for the deck region. */
  ariaLabel?: string;
  /** Extra class on the outer wrapper. */
  className?: string;
  /** How many stacked cards to show behind the active one (default 2). */
  maxPeek?: number;
}

/** Px each stacked card shifts right + down from the one above it. */
const OFFSET = 9;

export function CardStack<T>({
  items,
  getKey,
  renderCard,
  renderExpanded,
  header,
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
      setIndex((i) => Math.min(count - 1, Math.max(0, i + delta)));
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
  const canExpand = Boolean(renderExpanded);
  const dots = count <= 12;
  const hasNav = count > 1;
  // Constant gutters (based on the deck's full depth, not the current
  // position) so the layout never shifts while browsing.
  const gutter = Math.min(maxPeek, count - 1) * OFFSET;

  // Stacked card backs behind the active card — deepest first so the nearest
  // paints on top. Keyed by ITEM so React reuses the element when a back
  // becomes the active card, letting its transform transition 9px → 0 (the
  // "slides up out of the pile" leg of the cycle animation).
  const backDepths: number[] = [];
  for (let d = Math.min(maxPeek, count - 1 - active); d >= 1; d--) {
    backDepths.push(d);
  }

  return (
    <div className={`pc-cardstack${className ? ` ${className}` : ""}`}>
      {hasNav || canExpand ? (
        <div className="pc-cardstack__bar">
          {hasNav ? (
            dots ? (
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
            )
          ) : null}
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
      ) : null}

      <div
        ref={deckRef}
        className="pc-cardstack__deck"
        role="group"
        aria-label={ariaLabel ?? `Card ${active + 1} of ${count}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{
          paddingRight: gutter,
          paddingBottom: gutter + (hasNav ? 15 : 2),
          paddingTop: header ? 13 : 2,
        }}
      >
        <div className="pc-cardstack__topwrap">
          {/* The pile: card backs offset down-right, clickable to jump ahead. */}
          {backDepths.map((depth) => {
            const idx = active + depth;
            return (
              <button
                key={getKey(items[idx], idx)}
                type="button"
                className="pc-cardstack__cardback"
                aria-hidden
                tabIndex={-1}
                title="Next card"
                onClick={() => setIndex(idx)}
                style={{
                  transform: `translate(${depth * OFFSET}px, ${depth * OFFSET}px)`,
                  zIndex: 2 - depth,
                }}
              />
            );
          })}

          {/* The card just cycled past — flies off to the left with a tilt and
              fade; stepping back flies it back onto the deck. */}
          {active > 0 ? (
            <div
              key={getKey(items[active - 1], active - 1)}
              className="pc-cardstack__card pc-cardstack__card--exit"
              aria-hidden
            >
              {renderCard(items[active - 1], active - 1)}
            </div>
          ) : null}

          {/* The active card — front and centre, on top of the pile. */}
          <div
            key={getKey(item, active)}
            className="pc-cardstack__card pc-cardstack__card--active"
          >
            {expanded && renderExpanded
              ? renderExpanded(item, active)
              : renderCard(item, active)}
          </div>

          {/* Category badge, overlapping the active card's top edge. */}
          {header ? <div className="pc-cardstack__header">{header}</div> : null}

          {/* On-card navigation, straddling the card's bottom edge. */}
          {hasNav ? (
            <>
              <button
                type="button"
                className="pc-cardstack__navpill pc-cardstack__navpill--prev"
                aria-label="Previous card"
                disabled={active === 0}
                onClick={() => step(-1)}
              >
                <ChevronLeft size={13} aria-hidden />
                <span>Prev</span>
              </button>
              <button
                type="button"
                className="pc-cardstack__navpill pc-cardstack__navpill--next"
                aria-label="Next card"
                disabled={active >= count - 1}
                onClick={() => step(1)}
              >
                <span>Next</span>
                <ChevronRight size={13} aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      </div>

      <style>{`
      .pc-cardstack { display: flex; flex-direction: column; gap: 5px; }
      .pc-cardstack__bar { display: flex; align-items: center; gap: 8px; min-height: 14px; padding-inline: 3px; }
      .pc-cardstack__deck { position: relative; outline: none; border-radius: 14px; }
      .pc-cardstack__deck:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #7dd3fc) 55%, transparent); }
      .pc-cardstack__topwrap { position: relative; }

      /* ── The cards ─────────────────────────────────────────────────────── */
      /* CardStack owns the card chrome (consumers' inner card boxes are reset
         below) so every deck reads as REAL cards: raised surface, soft edge
         highlight, deep shadow. */
      .pc-cardstack__card {
        position: relative; z-index: 3;
        border-radius: 13px;
        border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 22%, var(--border, rgba(125, 211, 252, 0.2)));
        background: linear-gradient(168deg,
          color-mix(in srgb, var(--accent, #7dd3fc) 7%, var(--bg-2, rgba(255, 255, 255, 0.05))) 0%,
          var(--bg-2, rgba(255, 255, 255, 0.04)) 60%);
        box-shadow: 0 12px 26px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        transition: transform 280ms cubic-bezier(0.22, 0.85, 0.3, 1), opacity 200ms ease;
      }
      /* Consumers' own card boxes render INSIDE this chrome — strip theirs so
         the deck never shows a double border. */
      .pc-cardstack .pc-cardstack__card > * {
        border: none; background: transparent; box-shadow: none;
      }
      .pc-cardstack__card--active { position: relative; z-index: 3; }
      .pc-cardstack__card--exit {
        position: absolute; inset: 0; z-index: 4;
        transform: translate(-45%, -6%) rotate(-6deg);
        opacity: 0; pointer-events: none;
        overflow: hidden;
      }

      /* Card backs — the visible pile, each a little right of + below the one
         above it. Clickable to jump ahead. */
      .pc-cardstack__cardback {
        position: absolute; inset: 0; padding: 0; cursor: pointer;
        border-radius: 13px;
        border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 12%, var(--border, rgba(125, 211, 252, 0.16)));
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.04)) 100%, transparent);
        box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3);
        transition: transform 280ms cubic-bezier(0.22, 0.85, 0.3, 1), filter 140ms ease;
      }
      .pc-cardstack__cardback:hover { filter: brightness(1.25); }
      @media (prefers-reduced-motion: reduce) {
        .pc-cardstack__card, .pc-cardstack__cardback { transition: none; }
      }

      /* ── Category badge, sitting ON the active card's top edge ─────────── */
      .pc-cardstack__header {
        position: absolute; top: -12px; left: 12px; z-index: 5;
        display: inline-flex; align-items: center; gap: 7px;
        max-width: calc(100% - 24px);
        padding: 3px 10px; border-radius: 8px;
        background: var(--bg-1, #0d151d);
        border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 32%, var(--border, rgba(125, 211, 252, 0.2)));
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
        font-size: 10.5px; white-space: nowrap;
      }
      .pc-cardstack__header-label {
        font-weight: 700; color: var(--fg, #e7eef5);
        overflow: hidden; text-overflow: ellipsis;
      }
      .pc-cardstack__header-count {
        font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums;
      }

      /* ── On-card Prev / Next pills, straddling the card's bottom edge ──── */
      .pc-cardstack__navpill {
        position: absolute; bottom: -13px; z-index: 6;
        display: inline-flex; align-items: center; gap: 3px;
        height: 26px; padding: 0 11px; border-radius: 999px; cursor: pointer;
        font: inherit; font-size: 11px; font-weight: 700; letter-spacing: 0.01em;
        border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 42%, var(--border, rgba(125, 211, 252, 0.2)));
        background: var(--bg-1, #0d151d); color: var(--fg-dim, #b9d4e8);
        box-shadow: 0 5px 14px rgba(0, 0, 0, 0.45);
        transition: transform 140ms ease, color 140ms ease, background 140ms ease, border-color 140ms ease;
      }
      .pc-cardstack__navpill--prev { left: 10px; }
      .pc-cardstack__navpill--next { right: 10px; }
      .pc-cardstack__navpill:hover:not(:disabled) {
        color: var(--fg, #e7eef5);
        background: color-mix(in srgb, var(--accent, #7dd3fc) 15%, var(--bg-1, #0d151d));
        transform: translateY(-1px);
      }
      .pc-cardstack__navpill:disabled { opacity: 0.3; cursor: default; }

      /* ── Position indicator, above the card ────────────────────────────── */
      .pc-cardstack__dots { display: flex; align-items: center; gap: 5px; }
      .pc-cardstack__dot {
        width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; cursor: pointer;
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4) 45%, transparent);
        transition: width 200ms ease, background 200ms ease;
      }
      .pc-cardstack__dot:hover { background: var(--fg-mute, #7f9bb4); }
      .pc-cardstack__dot.is-active {
        width: 22px;
        background: var(--accent, #7dd3fc);
        box-shadow: 0 0 8px color-mix(in srgb, var(--accent, #7dd3fc) 45%, transparent);
      }
      .pc-cardstack__count {
        font-size: 11px; font-variant-numeric: tabular-nums; color: var(--fg-dim, #b9d4e8);
      }
      .pc-cardstack__count i { font-style: normal; color: var(--fg-mute, #7f9bb4); }
      .pc-cardstack__expand {
        margin-left: auto; padding: 2px 10px; border-radius: 999px; cursor: pointer;
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
