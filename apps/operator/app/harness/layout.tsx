import type { ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { HarnessZeroProvider } from '../../providers/HarnessZeroProvider';

/**
 * Wraps every /harness/* route with the harness Zero instance so panels
 * inside HarnessDashboard can `useQuery(queries.<...>())` for live sync.
 *
 * Routes outside /harness (marketplace, settings, public pages) don't get
 * Zero, keeping their bundles clean.
 */
export default function HarnessLayout({ children }: { children: ReactNode }) {
  return (
    <HarnessZeroProvider>
      <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
        {children}
      </Tooltip.Provider>
    </HarnessZeroProvider>
  );
}
