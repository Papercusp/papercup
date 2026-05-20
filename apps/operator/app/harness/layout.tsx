import type { ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';

/**
 * Wraps every /harness/* route with the radix Tooltip provider.
 *
 * The harness Zero sync instance (`HarnessZeroProvider`) is NOT mounted
 * here — it was hoisted to the root layout via `RootSyncProvider`
 * (2026-05-07) so every route shares one sync transport. Re-mounting it
 * here too would nest a second `SyncProvider`, opening a *second*
 * `/api/zero-harness/sse` connection that no consumer reads — a wasted
 * slot against the browser's 6-connection-per-host HTTP/1.1 cap, which
 * starves on-demand EventSources (e.g. the live-thinking popover).
 */
export default function HarnessLayout({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
      {children}
    </Tooltip.Provider>
  );
}
