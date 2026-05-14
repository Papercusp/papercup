/**
 * HarnessSelectorChip — moved-from-header harness picker, lives in the
 * OperatorChatSidebar's new sub-row.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.4
 *
 * Drives:
 *   - `?focusSlug=` (nuqs) — default slug for newly-opened panels
 *   - agent context default ("show me X" without explicit harness)
 *
 * Does NOT retroactively change open panels — that's the point of the
 * §3.4 unbundling. Each panel carries its own `params.harnessSlug`.
 */

'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useQueryState, parseAsString } from 'nuqs';

export interface HarnessOption {
  slug: string;
  label: string;
}

interface HarnessSelectorChipProps {
  options: HarnessOption[];
  className?: string;
}

export function HarnessSelectorChip({ options, className }: HarnessSelectorChipProps) {
  const [focusSlug, setFocusSlug] = useQueryState(
    'focusSlug',
    parseAsString.withDefault(''),
  );
  const [open, setOpen] = useState(false);

  // Best-effort: if no focusSlug set, pick the first option.
  useEffect(() => {
    if (!focusSlug && options.length > 0) {
      void setFocusSlug(options[0].slug);
    }
  }, [focusSlug, options, setFocusSlug]);

  const active = options.find((o) => o.slug === focusSlug) ?? options[0];

  return (
    <div className={className} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch active harness"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 6px 2px 8px',
          height: 22,
          fontSize: 11,
          fontWeight: 500,
          background: 'var(--card, #1a1a1a)',
          color: 'var(--foreground, #ccc)',
          border: '1px solid var(--border, #333)',
          borderRadius: 11,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {active?.label ?? 'no harness'}
        </span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 28,
            left: 0,
            minWidth: 180,
            maxHeight: 240,
            overflowY: 'auto',
            background: 'var(--card, #1a1a1a)',
            border: '1px solid var(--border, #333)',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 1000,
          }}
          onMouseLeave={() => setOpen(false)}
        >
          {options.map((o) => (
            <button
              key={o.slug}
              type="button"
              role="option"
              aria-selected={o.slug === focusSlug}
              onClick={() => {
                void setFocusSlug(o.slug);
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: 12,
                background: o.slug === focusSlug ? 'var(--accent, #2a2a2a)' : 'transparent',
                color: 'var(--foreground, #ccc)',
                border: 0,
                cursor: 'pointer',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
