'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import type { CSSProperties } from 'react';

/**
 * The six autonomy ceilings in ascending-autonomy order — `never-auto` (nothing
 * auto-runs) then the five risk tiers. Mirrors `AUTONOMY_CEILINGS` from
 * `@papercusp/plan-parser`; re-declared locally per the client wire-type
 * decoupling convention (the server validates the actual values on write).
 */
export const CEILING_LEVELS = ['never-auto', 'trivial', 'low', 'moderate', 'high', 'critical'] as const;
export type Ceiling = (typeof CEILING_LEVELS)[number];

export const CEILING_SHORT_LABEL: Record<Ceiling, string> = {
  'never-auto': 'Never',
  trivial: 'Trivial',
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  critical: 'Critical',
};

const ROW_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'flex-start',
  gap: 2,
};

/** Compact track: dots only (names live in the column header + per-dot title). */
const COMPACT_ROW_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
};

function stopStyle(disabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    width: 58,
    background: 'transparent',
    border: 'none',
    padding: '2px 0',
    cursor: disabled ? 'default' : 'pointer',
    font: 'inherit',
  };
}

function compactStopStyle(disabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    padding: '3px 3px',
    cursor: disabled ? 'default' : 'pointer',
    font: 'inherit',
  };
}

function dotStyle(filled: boolean, active: boolean): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: '1px solid var(--border)',
    background: filled ? 'var(--accent)' : 'var(--bg-2)',
    outline: active ? '2px solid var(--accent)' : 'none',
    outlineOffset: 1,
    boxSizing: 'border-box',
  };
}

function labelStyle(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    lineHeight: 1.2,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--fg)' : 'var(--fg-mute)',
  };
}

/**
 * CeilingSlider — the per-category risk-ceiling control (B-15 / P-030):
 * "auto-run anything in this category up to tier X". A horizontal ordinal
 * segmented control over the six {@link CEILING_LEVELS} (never-auto … critical),
 * rendered as an accessible `radiogroup` (each stop a labeled radio) rather than a
 * native range input so the discrete named levels stay legible + arrow-key
 * navigable. Higher = more autonomy; `never-auto` is the leftmost zero, and every
 * stop up to and including the selected one is filled (a slider-like track).
 *
 * The control only proposes a ceiling; nothing auto-runs until the EFFECTIVE level
 * (min of this ceiling and the earned graduated level) rises and the policy is
 * armed — the page renders ceiling / graduated / effective separately so a freshly
 * raised ceiling reading effective=none isn't mistaken for a bug.
 */
export function CeilingSlider({
  value,
  onChange,
  disabled = false,
  ariaLabel,
  compact = false,
}: {
  value: Ceiling;
  onChange: (next: Ceiling) => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** Dots-only track — for the single-line settings table (B-15 compact pass). */
  compact?: boolean;
}) {
  const idx = Math.max(0, CEILING_LEVELS.indexOf(value));

  const moveBy = (delta: number) => {
    if (disabled) return;
    const nextIdx = Math.min(CEILING_LEVELS.length - 1, Math.max(0, idx + delta));
    const next = CEILING_LEVELS[nextIdx];
    if (next && next !== value) onChange(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel ?? 'Risk ceiling'}
      aria-disabled={disabled || undefined}
      style={{ ...(compact ? COMPACT_ROW_STYLE : ROW_STYLE), opacity: disabled ? 0.5 : 1 }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveBy(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          moveBy(-1);
        }
      }}
    >
      {CEILING_LEVELS.map((lvl, i) => {
        const active = i === idx;
        const filled = i <= idx;
        return (
          <Tooltip key={lvl} label={compact ? CEILING_SHORT_LABEL[lvl] : undefined}><button

            type="button"
            role="radio"
            aria-checked={active}
            aria-label={CEILING_SHORT_LABEL[lvl]}
            disabled={disabled}
            tabIndex={active ? 0 : -1}
            data-level={lvl}

            style={compact ? compactStopStyle(disabled) : stopStyle(disabled)}
            onClick={() => {
              if (!disabled && lvl !== value) onChange(lvl);
            }}
          >
            <span aria-hidden="true" style={dotStyle(filled, active)} />
            {!compact && <span style={labelStyle(active)}>{CEILING_SHORT_LABEL[lvl]}</span>}
          </button></Tooltip>
        );
      })}
    </div>
  );
}
