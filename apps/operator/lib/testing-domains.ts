/**
 * Re-export shim. The testing-domains registry moved to the shared
 * @papercusp/testing-shell package as Phase A (P-001) of
 * harness-tests-tab-and-tester-promotion-2026-05-26, so the harness
 * Tests tab can consume the same shell as /admin/testing.
 *
 * This shim keeps every existing `@/lib/testing-domains` import site
 * working unchanged (testing-domains-registry.ts, the four admin
 * endpoint routes, and the two test files). New code should import from
 * `@papercusp/testing-shell` directly.
 */
export * from '@papercusp/testing-shell';
