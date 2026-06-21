'use client';

/**
 * presence-ui — shared liveness primitives for the agent-presence surfaces:
 * the /coord dashboard and the /adv Sessions roster.
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
import type { CSSProperties } from 'react';
import styles from './presence-ui.module.css';

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

/**
 * A small 3-state liveness indicator. Portable across both styling systems
 * and tokenized through CSS so route chrome can skin it without hardcoded
 * colors. `title` overrides the default per-state tooltip.
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
      className={styles.dot}
      title={title ?? LIVENESS_TITLE[liveness]}
      style={{
        '--liveness-dot-size': `${size}px`,
      } as CSSProperties}
    />
  );
}
