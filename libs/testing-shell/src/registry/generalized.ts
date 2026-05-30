/**
 * generalizedRegistry — testing domains that apply to ANY coding harness,
 * not just Papercusp. Phase B / P-010 of
 * harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * These live in @papercusp/testing-shell (not in the operator) so the
 * harness Tests tab (Phase C) can consume them directly: it renders them
 * under the "Built-in" tier (tier: 'generalized' → tierLabels.generalized).
 *
 * IMPORTANT: this module is PURE DATA — it does NOT call `defineTestDomain`.
 * Registration into the shared `_registry` Map (read by /admin/testing's
 * getTestDomain / listTestDomains) is performed by the consumer that needs
 * it — the operator barrel `apps/operator/lib/testing-domains-registry.ts`
 * does `generalizedRegistry.forEach(defineTestDomain)`. Keeping this file
 * side-effect-free is what lets the lib stay `sideEffects: false` without a
 * tree-shaking footgun.
 *
 * Glob/runner shapes are unchanged from their original /admin/testing
 * declarations (admin-testing-tab-restructure-2026-05-24); only `tier`
 * changed from quick/surface to the shared `generalized`.
 */

import { type TestDomain } from '../registry';

export const generalizedRegistry: TestDomain[] = [
  {
    id: 'test-runs',
    label: 'Test Runs',
    description: 'Suite orchestrator: start / poll / cancel named suites.',
    tier: 'generalized',
    // Placeholder section — custom UI in operator-vite via P-006a.
    sections: [
      {
        id: 'all',
        label: 'Suites',
        description: 'All admin-test-suite runs.',
        runners: [{ kind: 'admin-suite', suiteId: 'desktop-health' }],
      },
    ],
  },
  {
    id: 'live',
    label: 'Live',
    description: 'Passive observer: interactions, console, layout, unhandled errors.',
    tier: 'generalized',
    sections: [
      { id: 'all', label: 'Observers', globs: ['apps/operator/app/admin/testing/_lib/vitals-*.test.ts'] },
    ],
  },
  {
    id: 'chaos',
    label: 'Chaos',
    description: 'Autonomous clicker that drives the Tauri shell looking for crashes.',
    tier: 'generalized',
    sections: [
      { id: 'host', label: 'Recorder host', globs: ['apps/operator/app/admin/testing/_lib/chaos-*.test.ts'] },
    ],
  },
  {
    id: 'ai',
    label: 'AI Explore',
    description: 'Stagehand LLM walk over admin routes.',
    tier: 'generalized',
    sections: [
      {
        id: 'prompts',
        label: 'Prompts',
        runners: [{ kind: 'admin-suite', suiteId: 'ai-explore-prompts' }],
      },
    ],
  },
  {
    id: 'routes',
    label: 'Routes',
    description: 'Per-route INP rollup + Hono endpoint test surface.',
    tier: 'generalized',
    sections: [
      {
        id: 'endpoint-tests',
        label: 'Endpoint tests',
        globs: ['apps/operator/lib/endpoint-route/__tests__/**/*.test.ts'],
      },
    ],
  },
];
