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
 *
 * SELF HARNESS: for the operator's own dogfood harness (`papercup`), the
 * generalized-only set is nearly empty + non-functional (its globs target
 * operator-internal paths, and its admin-suite runners aren't wired into the
 * harness data-source). `harnessTestingRegistryFor(slug)` returns the FULL
 * /admin/testing set there instead — see `./self-harness`.
 */

import { generalizedRegistry, type TestDomain } from './testing-domains';
import { adminRegistry } from './testing-domains-registry';
import { isSelfHarness } from './self-harness';

export const ACCEPTANCE_DOMAIN_ID = 'acceptance';

const ACCEPTANCE_DOMAIN: TestDomain = {
  id: ACCEPTANCE_DOMAIN_ID,
  label: 'Acceptance',
  description: 'VAL-covering tests written by the tester (from .harness/tests.json).',
  tier: 'project',
  sections: [{ id: 'all', label: 'All VALs' }],
};

/** The generic harness Tests tab's domains: Built-in (generalized) + Project (acceptance). */
export const harnessTestingRegistry: TestDomain[] = [...generalizedRegistry, ACCEPTANCE_DOMAIN];

/**
 * The self/dogfood harness's domains: the full /admin/testing set (generalized
 * + the 16 Papercusp domains) plus the Project/Acceptance tab. This is what
 * the `papercup` harness Tests tab renders so it surfaces every operator test
 * domain, not just the sparse generalized tier.
 */
export const selfHarnessTestingRegistry: TestDomain[] = [...adminRegistry, ACCEPTANCE_DOMAIN];

/** Pick the right registry for a harness: full set for the self harness, generic otherwise. */
export function harnessTestingRegistryFor(slug: string): TestDomain[] {
  return isSelfHarness(slug) ? selfHarnessTestingRegistry : harnessTestingRegistry;
}

/** tierId → section heading for the generic harness Tests tab (TestingShell tierLabels). */
export const HARNESS_TESTING_TIER_LABELS: Record<string, string> = {
  generalized: 'Built-in',
  project: 'Project',
};

/** Tier headings for the self harness (adds the Papercusp domains' tiers). */
export const SELF_HARNESS_TESTING_TIER_LABELS: Record<string, string> = {
  generalized: 'Built-in',
  quick: 'Quick runs',
  domain: 'Domains',
  surface: 'Surfaces',
  project: 'Project',
};

export function harnessTierLabelsFor(slug: string): Record<string, string> {
  return isSelfHarness(slug) ? SELF_HARNESS_TESTING_TIER_LABELS : HARNESS_TESTING_TIER_LABELS;
}
