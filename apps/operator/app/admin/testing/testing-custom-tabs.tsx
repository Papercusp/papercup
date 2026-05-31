'use client';

import type { ReactElement } from 'react';
import ChaosTab from './_components/ChaosTab';
import AIExploreTab from './_components/AIExploreTab';
import LiveMetricsTab from './_components/LiveMetricsTab';
import RoutesTab from './_components/RoutesTab';
import PackagedBuildTab from './_components/PackagedBuildTab';
import LlmTab from './_components/LlmTab';
import TestRunsTab from './_components/TestRunsTab';
import MemoryTab from './_components/MemoryTab';

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
};
