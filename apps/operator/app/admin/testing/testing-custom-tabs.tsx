'use client';

import type { ReactElement } from 'react';
import { ChaosWebPanel, LiveWebPanel } from '@papercusp/testing-shell';
import ChaosTab from './_components/ChaosTab';
import AIExploreTab from './_components/AIExploreTab';
import LiveMetricsTab from './_components/LiveMetricsTab';
import RoutesTab from './_components/RoutesTab';
import PackagedBuildTab from './_components/PackagedBuildTab';
import LlmTab from './_components/LlmTab';
import TestRunsTab from './_components/TestRunsTab';
import MemoryTab from './_components/MemoryTab';

// Base URL the browser-chaos run drives — the BUILT operator SPA on :3070 (the
// port the desktop webview loads). NOT :3055: that's the Vite HMR dev server,
// which throws `createHotContext` in a plain headless browser so nothing
// renders. :3070 serves the hashed-asset build that actually paints + clicks.
const OPERATOR_SPA_URL = 'http://127.0.0.1:3070/';

/**
 * The 8 bespoke testing panels (P-006a), as an id→component map.
 *
 * SHARED between `/admin/testing` (operator-vite `TestingClient`) and the
 * `/adv` harness Tests tab (`HarnessTestsView`) so both render the IDENTICAL
 * panels — the harness tab is the same UI, just driven from the harness's own
 * config (its registry + data source) instead of the admin-global one. Tabs
 * not in this map render via the shared `<DomainTestPanel>`.
 *
 * Lives under `app/admin/testing/` (alongside `_components/`) so it is
 * importable from both operator-vite (`@/app/...`) and the `/adv` view.
 */
export const TESTING_CUSTOM_TABS: Record<string, () => ReactElement> = {
  'test-runs': TestRunsTab,
  live: LiveMetricsTab,
  memory: MemoryTab,
  chaos: ChaosTab,
  ai: AIExploreTab,
  routes: RoutesTab,
  packaged: PackagedBuildTab,
  llm: LlmTab,
  // Browser-platform variants of chaos/live (platform-variants P-009). live-web
  // is a pure in-page observer (no backend); chaos-web drives the SPA via the
  // /api/admin/testing/chaos-web spawn route. Hidden unless the host sets
  // platform 'web' or 'both' (the desktop chaos/live are tagged 'desktop').
  'live-web': LiveWebPanel,
  'chaos-web': () => <ChaosWebPanel runEndpoint="/api/admin/testing/chaos-web" baseUrl={OPERATOR_SPA_URL} />,
};
