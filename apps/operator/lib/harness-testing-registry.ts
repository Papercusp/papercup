/**
 * harness-testing-registry.ts — the registry the harness Tests tab renders.
 *
 * Phase C / P-022 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * It is `[...generalizedRegistry, ACCEPTANCE]`:
 *   - generalizedRegistry (from @papercusp/testing-shell, via the React/CSS-
 *     free `./testing-domains` shim) — the Built-in tier, glob-walked against
 *     the harness worktree.
 *   - ACCEPTANCE — the Project tier, whose "files" are the VAL-covering tests
 *     in the harness's `.harness/tests.json` (written by the tester). It has
 *     no globs/runners: the harness testing routes (P-024) populate its files
 *     from tests.json, not from a glob walk. (It is plain data, never passed
 *     through defineTestDomain, so the globs-or-runners invariant doesn't
 *     apply.)
 *
 * Shared by the server routes (apps/operator/lib/endpoint-route/routes/harness/
 * testing.ts) and the AdvTestsPanel (apps/operator/app/adv/harnesses/). Both
 * import this module; it is React/CSS-free and safe server-side.
 */

import { generalizedRegistry, type TestDomain } from './testing-domains';

export const ACCEPTANCE_DOMAIN_ID = 'acceptance';

const ACCEPTANCE_DOMAIN: TestDomain = {
  id: ACCEPTANCE_DOMAIN_ID,
  label: 'Acceptance',
  description: 'VAL-covering tests written by the tester (from .harness/tests.json).',
  tier: 'project',
  sections: [{ id: 'all', label: 'All VALs' }],
};

/** The harness Tests tab's domains: Built-in (generalized) + Project (acceptance). */
export const harnessTestingRegistry: TestDomain[] = [...generalizedRegistry, ACCEPTANCE_DOMAIN];

/**
 * tierId → section heading for the harness Tests tab (TestingShell tierLabels).
 * Two tiers: "Universal" = built-ins that apply to ANY harness; "This Harness"
 * = tests specific to this harness (its own domains + Acceptance).
 */
export const HARNESS_TESTING_TIER_LABELS: Record<string, string> = {
  generalized: 'Universal',
  project: 'This Harness',
};
