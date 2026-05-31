/**
 * Self / dogfood harness detection.
 *
 * The "self" harness is the operator's OWN source repo managed as a harness
 * (the dogfood substrate). Its slug is the repo directory basename — `papercup`
 * — because the orchestrator derives a harness slug from the project dir
 * basename (`harnessSlug()`).
 *
 * Why this matters: the generic harness Tests tab (`harnessTestingRegistry`)
 * shows only the "Built-in" generalized domains + the harness's own Acceptance
 * tests. But those generalized domains' globs target operator-internal paths
 * (`apps/operator/…`, `packages/…`) — they only resolve against the self
 * harness's worktree. For the self harness specifically, the Tests tab should
 * surface the FULL /admin/testing domain set (the 16 Papercusp domains, where
 * the operator's real unit/integration tests live). See
 * `harnessTestingRegistryFor()` in `harness-testing-registry.ts`.
 *
 * Pure data (no Node/server imports) so both the server routes and the
 * `'use client'` HarnessTestsView can import it.
 */
export const SELF_HARNESS_SLUGS: ReadonlySet<string> = new Set(['papercup', 'papercusp']);

export function isSelfHarness(slug: string): boolean {
  return SELF_HARNESS_SLUGS.has(slug);
}
