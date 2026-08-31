/**
 * The seams — everything this package deliberately does NOT own, expressed as
 * injected components and callbacks.
 *
 * These three groups are exactly the reasons the original component could not be
 * imported by a second surface:
 *   · CHROME  — it imported the operator's Popover / Tooltip / LivenessDot /
 *               ThinkingDot by `@/app/...` path.
 *   · LABELS  — it called a React lexicon hook, which binds it to one app's
 *               provider tree.
 *   · ACTIONS — it POSTed to same-origin operator routes and opened an operator
 *               inspector modal. A cross-origin host has its own auth and its own
 *               endpoints.
 *
 * Each has a working default (`defaultRosterChrome`, `identityRosterLabels`), so
 * a host adopts the roster with data alone and adds fidelity as it needs it.
 */
import type { ComponentType, ReactNode } from 'react';
import type { Liveness, RosterAgent } from './types';
import type { RosterTermKey } from './glyphs';

export interface LivenessDotProps {
  liveness: Liveness;
  size?: number;
  title?: string;
}

export interface ThinkingDotProps {
  size?: number;
  title?: string;
}

export interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

/** The host's presentational primitives. */
export interface RosterChrome {
  Tooltip: ComponentType<TooltipProps>;
  LivenessDot: ComponentType<LivenessDotProps>;
  ThinkingDot: ComponentType<ThinkingDotProps>;
}

/** Unstyled stand-ins so the roster renders correctly with no host chrome at all
 *  — a plain dot with a `data-liveness` attribute the host's CSS can target, and
 *  a tooltip that degrades to a native `title`. A host that has real primitives
 *  passes them; nothing here is a design decision the host cannot override. */
export const defaultRosterChrome: RosterChrome = {
  Tooltip: ({ label, children }: TooltipProps) => (
    <span title={typeof label === 'string' ? label : undefined}>{children}</span>
  ),
  LivenessDot: ({ liveness, size = 8, title }: LivenessDotProps) => (
    <span
      role="img"
      aria-label={`${liveness} agent`}
      data-liveness={liveness}
      title={title}
      className="pc-agents-roster__dot"
      style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%' }}
    />
  ),
  ThinkingDot: ({ size = 7, title = 'thinking' }: ThinkingDotProps) => (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-liveness="thinking"
      className="pc-agents-roster__dot pc-agents-roster__dot--thinking"
      style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%' }}
    />
  ),
};

/** The host's vocabulary. The operator binds its lexicon through these; a host
 *  without one keeps the words it was given. */
export interface RosterLabels {
  /** The display word for a cast term (the kind legend). */
  term(key: RosterTermKey, opts?: { lower?: boolean }): string;
  /** Normalize a STORED agent label — the operator maps internal cast words onto
   *  the brand's vocabulary here. Arbitrary human labels must pass through. */
  agentLabel(raw: string): string;
  /** Normalize a role id to a display word. */
  roleLabel(raw: string | null | undefined): string;
}

/** Labels that change nothing — the correct default for a host with no lexicon. */
export const identityRosterLabels: RosterLabels = {
  term: (key, opts) => (opts?.lower ? key.toLowerCase() : key),
  agentLabel: (raw) => raw,
  roleLabel: (raw) => raw?.trim() ?? '',
};

/**
 * The bulk actions the selection bar drives. Every one is the HOST's — they hit
 * its endpoints with its auth. Omit the whole object and the roster renders with
 * no checkboxes and no bulk bar, which is the correct read-only surface for a
 * host that cannot (or should not) act on agents.
 *
 * Each returns a short note to show the user — the same string the operator's bar
 * prints today ("Sent to 3", "Focused 2/3"). Returning null shows nothing.
 */
export interface RosterBulkActions {
  message?(ownerIds: readonly string[], text: string): Promise<string | null>;
  wake?(ownerIds: readonly string[]): Promise<string | null>;
  focus?(agents: readonly RosterAgent[]): Promise<string | null>;
  /** Confirm-armed in the UI: the first click arms, the second calls this. */
  kill?(agents: readonly RosterAgent[]): Promise<string | null>;
  copyIds?(ownerIds: readonly string[]): Promise<string | null>;
}
