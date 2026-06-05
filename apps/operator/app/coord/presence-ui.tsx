'use client';

/**
 * presence-ui — shared liveness primitives for the agent-presence surfaces:
 * the /coord dashboard (Tailwind) and the /adv Sessions roster (pc-* CSS).
 *
 * Only the genuinely style-neutral atom is shared — the 3-state LivenessDot +
 * the client-side liveness derivation. The two surfaces' ROW markup differs too
 * much (dark Tailwind dashboard vs the pc-* roster) to share a single row
 * component without a leaky props API, so each builds its own row on this dot.
 *
 * The liveness thresholds come from the dep-free leaf @/lib/liveness (the same
 * source the server roster endpoint uses), so client + server can't drift.
 */

import { deriveLiveness, type Liveness } from '@papercusp/operator-core/lib/liveness';

export type { Liveness };

/** Liveness from a heartbeat ISO string, using the current wall clock. */
export function livenessFromHeartbeat(heartbeatAtIso: string, nowMs: number = Date.now()): Liveness {
  return deriveLiveness(heartbeatAtIso, nowMs);
}

export const LIVENESS_TITLE: Record<Liveness, string> = {
  live: 'Active — tool call < 1 min ago',
  idle: 'Idle — no recent tool call (may be mid-reasoning), not gone',
  stale: 'Stale — no heartbeat in > 10 min',
};

const DOT_COLOR: Record<Liveness, string> = {
  live: '#34d399', // emerald-400
  idle: '#fbbf24', // amber-400
  stale: '#6b7280', // gray-500
};

/**
 * A small 3-state liveness indicator. Portable across both styling systems
 * (inline-styled, not class-bound). A design-token pass tokenizes the colors in
 * P-010. `title` overrides the default per-state tooltip.
 */
export function LivenessDot({
  liveness,
  title,
  size = 8,
}: {
  liveness: Liveness;
  title?: string;
  size?: number;
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={`${liveness} agent`}
      data-liveness={liveness}
      title={title ?? LIVENESS_TITLE[liveness]}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: DOT_COLOR[liveness],
        flexShrink: 0,
        // a soft halo on live to draw the eye to who's active right now
        boxShadow: liveness === 'live' ? `0 0 0 2px ${DOT_COLOR.live}33` : undefined,
      }}
    />
  );
}
