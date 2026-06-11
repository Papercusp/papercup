'use client';

/**
 * Shared friendly error state for the Cupboard surfaces (EI-215).
 *
 * The listings slot, the tools view, and the detail page all used to render
 * the raw caught exception (`String(err)` → "TypeError: Load failed",
 * "Error: HTTP 404") with no retry affordance. This component owns the
 * raw→friendly copy mapping and always offers an inline Retry; the raw text
 * stays visible muted for debugging, never as the headline.
 */

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { FONTS, RADIUS, SIZES } from './cupboard-theme';

export function friendlyCupboardError(raw: string, what: string): string {
  const httpMatch = /HTTP (\d{3})/.exec(raw);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 404) {
      return what === 'this listing'
        ? "This listing doesn't exist — it may have been unpublished or removed."
        : `Couldn't find ${what} — the Cupboard server returned 404.`;
    }
    if (status === 503) return 'The Cupboard server is unavailable. Is PAPERCUSP_CUPBOARD_URL configured?';
    if (status >= 500) return `The Cupboard server hit an error (HTTP ${status}) while loading ${what}.`;
    return `Couldn't load ${what} (HTTP ${status}).`;
  }
  // No HTTP status → a network-level failure: WebKit "TypeError: Load failed",
  // Chromium "TypeError: Failed to fetch", Firefox "NetworkError…".
  return `Couldn't reach the Cupboard server while loading ${what} — it may be briefly unavailable.`;
}

export function CupboardErrorState({
  raw,
  what,
  onRetry,
}: {
  /** The raw caught error string — rendered muted, for debugging. */
  raw: string;
  /** What failed to load, woven into the copy: 'listings' | 'tools' | 'this listing'. */
  what: string;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="cupboard-error-state"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        color: 'var(--danger)',
        fontFamily: FONTS.ui,
        fontSize: 12,
        marginBottom: SIZES.md,
        padding: 12,
        border: '1px solid color-mix(in srgb, var(--danger), transparent 70%)',
        borderRadius: RADIUS.lg,
        background: 'var(--error-bg)',
      }}
    >
      <AlertTriangle size={14} style={{ flexShrink: 0 }} />
      <span>{friendlyCupboardError(raw, what)}</span>
      <span style={{ color: 'var(--fg-mute)', opacity: 0.75 }}>({raw})</span>
      <button
        onClick={onRetry}
        data-testid="cupboard-error-retry"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginLeft: 'auto',
          padding: '5px 12px',
          border: '1px solid color-mix(in srgb, var(--danger), transparent 55%)',
          borderRadius: RADIUS.sm,
          background: 'transparent',
          color: 'var(--danger)',
          fontFamily: FONTS.ui,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  );
}
