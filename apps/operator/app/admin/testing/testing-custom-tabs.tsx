'use client';

import type { ReactElement } from 'react';
import { buildUniversalTesting, type TestingShellTab } from '@papercusp/testing-shell';
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
 * The universal test panels (Live / Chaos-web / AI Explore / Chaos-desktop),
 * wired ONCE here via `buildUniversalTesting` (universal-testing-domains-generic
 * Phase 6) — the same "config not code" surface Restart's /tests uses. The lib
 * owns the panels + their spawn/stream substance; the operator just supplies its
 * endpoints + base URL.
 *
 * - chaos-web / ai-explore POST to the operator's /api/admin/testing/* routes
 *   (which delegate to the testing-shell server cores, P-063).
 * - chaos-desktop opens a recorder window at the current origin; the lib's
 *   <RecorderHost> (mounted in operator-vite __root.tsx) runs the observers +
 *   clicker. The lib's recorder-channel is channel/storage-compatible with the
 *   operator's _lib (same CHANNEL_NAME + localStorage key), so RoutesTab still
 *   sees chaos-desktop runs.
 * - liveObserver (live-web) is a pure in-page observer, no backend.
 */
const universal = buildUniversalTesting({
  liveObserver: true,
  chaosWeb: { runEndpoint: '/api/admin/testing/chaos-web', baseUrl: OPERATOR_SPA_URL },
  aiExplore: {
    runEndpoint: '/api/admin/testing/ai-explore',
    defaultStartUrl: 'http://127.0.0.1:3055/',
    defaultGoal: 'Open the harnesses page, click into the first harness, switch to the Issues tab.',
  },
  chaosDesktop: { defaultRoute: '/' }, // recorderUrl defaults to the current origin
});

/** The universal tabs' metadata (Live / Chaos-web / AI Explore / Chaos-desktop), for the host tab lists. */
export const UNIVERSAL_TESTING_TABS: TestingShellTab[] = universal.tabs;

/**
 * id→component map for the testing panels.
 *
 * SHARED between `/admin/testing` (operator-vite `TestingClient`) and the
 * `/adv` harness Tests tab (`HarnessTestsView`) so both render the IDENTICAL
 * panels. The universal panels come from `buildUniversalTesting` (single
 * source); the rest are operator-specific (Test Runs / Live metrics (vitals) /
 * Memory / Routes / Packaged / LLM). Tabs not in this map render via the shared
 * `<DomainTestPanel>`.
 *
 * Lives under `app/admin/testing/` (alongside `_components/`) so it is
 * importable from both operator-vite (`@/app/...`) and the `/adv` view.
 */
export const TESTING_CUSTOM_TABS: Record<string, () => ReactElement> = {
  ...universal.customTabs, // live-web, chaos-web, ai-explore, chaos-desktop
  'test-runs': TestRunsTab,
  vitals: LiveMetricsTab, // operator desktop vitals (renamed from `live`; the universal observer owns `live-web`)
  memory: MemoryTab,
  routes: RoutesTab,
  packaged: PackagedBuildTab,
  llm: LlmTab,
};
