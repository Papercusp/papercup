/**
 * testing-domains.ts — declarative registry for the /admin/testing surface.
 *
 * Plan: apps/operator/docs/plans/admin-testing-tab-restructure-2026-05-24.md
 * Phase 1, P-001 + P-002.
 *
 * One entry per subtab. Each entry declares its sections, file globs, and
 * (optionally) ad-hoc runner descriptors. The admin UI walks the registry
 * via GET /api/admin/testing/domains/:id (P-003) — server-side glob walk,
 * no checked-in catalog to drift.
 *
 * Shape mirrors the agent-mcp `defineTool` pattern (drop a file, no
 * central switch to edit). Adding a new domain = call `defineTestDomain`
 * with a unique id and add to the export array below; the SPA renders it
 * automatically via the shared <DomainTestPanel>.
 *
 * Existing 8 tabs adopt this registry as descriptor only (P-006a):
 * bespoke React UI stays mounted via the `custom` slot.
 */

import type { ReactNode } from 'react';

/**
 * Discriminated union of every way a single test can be run from the UI.
 * The run route (POST /api/admin/testing/run, P-014) dispatches on `kind`.
 *
 * `vitest` / `playwright` / `cargo` are auto-discovered via globs.
 * `node` / `shell` are explicit ad-hoc runners — these will shrink to zero
 * after Phase 5 framework standardization (D-006).
 * `admin-suite` defers to the existing admin-test-suites orchestrator.
 */
export type TestRunner =
  | { kind: 'vitest'; filePath: string }
  | { kind: 'playwright'; filePath: string }
  | { kind: 'cargo'; crate: string; test?: string }
  | { kind: 'node'; cmd: string; args?: string[]; label?: string }
  | { kind: 'shell'; cmd: string; args?: string[]; label?: string }
  | { kind: 'admin-suite'; suiteId: string };

/**
 * One leaf section within a tab.
 *
 * Sections may declare:
 *  - `globs`: file paths discovered server-side, each rendered as a row.
 *  - `runners`: explicit non-vitest runners (`.mjs`/`.sh`/cargo) rendered
 *    as named buttons. Used while ad-hoc scripts await migration to
 *    Vitest in Phase 5; the descriptor disappears with the script.
 *
 * At least one of `globs` or `runners` must be present.
 */
export interface TestSection {
  id: string;
  label: string;
  description?: string;
  globs?: string[];
  runners?: TestRunner[];
}

/**
 * One subtab. Maps to a single entry in /admin/testing's left-column list.
 *
 * `custom`: an existing-tab bespoke React component (per P-006a). When
 * present, <DomainTestPanel> mounts it inside its shell instead of the
 * default sections list. The 8 existing tabs (test-runs, live, memory,
 * chaos, ai, routes, packaged, llm) declare custom; the 12 new tabs
 * leave it undefined and render the section list.
 *
 * `healthStripId`: opaque identifier the SPA maps to a per-domain health
 * widget. Strips show test-related signals only (P-033): last full-suite
 * duration, last failure timestamp, flaky rate. Operational health
 * (voice spend, lock queue, etc.) belongs on per-domain admin pages,
 * not here.
 */
export interface TestDomain {
  id: string;
  label: string;
  description: string;
  tier: 'quick' | 'domain' | 'surface';
  sections: TestSection[];
  healthStripId?: string;
  custom?: () => ReactNode;
}

const _registry = new Map<string, TestDomain>();

/**
 * Register a test domain. Throws on duplicate id (same shape as
 * defineSuite auto-loader — fail fast at module load).
 *
 * Validates `sections` invariant: every section must declare globs OR
 * runners (or both). An empty section would render an empty tab page,
 * which is always a mistake at registration time.
 */
export function defineTestDomain(domain: TestDomain): TestDomain {
  if (_registry.has(domain.id)) {
    throw new Error(
      `defineTestDomain: duplicate domain id "${domain.id}" — every domain id must be unique.`,
    );
  }
  if (domain.sections.length === 0) {
    throw new Error(
      `defineTestDomain: domain "${domain.id}" has no sections — at least one section is required.`,
    );
  }
  const sectionIds = new Set<string>();
  for (const section of domain.sections) {
    if (sectionIds.has(section.id)) {
      throw new Error(
        `defineTestDomain: domain "${domain.id}" has duplicate section id "${section.id}".`,
      );
    }
    sectionIds.add(section.id);
    const hasGlobs = (section.globs?.length ?? 0) > 0;
    const hasRunners = (section.runners?.length ?? 0) > 0;
    if (!hasGlobs && !hasRunners) {
      throw new Error(
        `defineTestDomain: domain "${domain.id}" section "${section.id}" ` +
          `must declare globs or runners (or both).`,
      );
    }
  }
  _registry.set(domain.id, domain);
  return domain;
}

/** Get one domain by id, or undefined. */
export function getTestDomain(id: string): TestDomain | undefined {
  return _registry.get(id);
}

/** Snapshot of every registered domain, ordered by tier then registration order. */
export function listTestDomains(): TestDomain[] {
  const tierOrder: Record<TestDomain['tier'], number> = {
    quick: 0,
    domain: 1,
    surface: 2,
  };
  return Array.from(_registry.values()).sort((a, b) => {
    const t = tierOrder[a.tier] - tierOrder[b.tier];
    if (t !== 0) return t;
    return 0;
  });
}

/**
 * INTERNAL — test-only. Clears the registry so test files can reseed it
 * with a known set without side effects from other tests. Not exported
 * from the package index.
 */
export function _resetTestDomainRegistry(): void {
  _registry.clear();
}
