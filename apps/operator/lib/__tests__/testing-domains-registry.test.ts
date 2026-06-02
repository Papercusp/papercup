/**
 * Smoke test: registry imports cleanly + every domain is well-shaped.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-002 verification.
 */

import { describe, expect, it } from 'vitest';
import './_loads-registry'; // side-effect import to populate the registry
import { listTestDomains, universalDomains } from '../testing-domains';
import { papercuspRegistry, adminRegistry } from '../testing-domains-registry';

describe('testing-domains-registry', () => {
  const domains = listTestDomains();

  it('registers exactly 28 domains', () => {
    expect(domains.length).toBe(28);
  });

  it('registers the `dogfood` domain with its 12 collaborative-substrate sections', () => {
    const dogfood = papercuspRegistry.find((d) => d.id === 'dogfood');
    expect(dogfood, 'dogfood domain must be registered (surfaces the shared-harness suite in the Tests tab)').toBeTruthy();
    const sectionIds = (dogfood!.sections ?? []).map((s) => s.id).sort();
    expect(sectionIds).toEqual(
      [
        'substrate', 'identity-binding', 'federation', 'claim', 'pr-lifecycle',
        'completion-ref', 'reactivity', 'revocation', 'cupboard', 'ui', 'routes', 'e2e',
      ].sort(),
    );
    // every section carries a glob or runner so the shell can resolve it
    for (const s of dogfood!.sections ?? []) {
      expect(Boolean(s.globs?.length) || Boolean(s.runners?.length), `section ${s.id} needs globs/runners`).toBe(true);
    }
  });

  it('every tier appears at least once', () => {
    const tiers = new Set(domains.map((d) => d.tier));
    expect(tiers.has('quick')).toBe(true);
    expect(tiers.has('domain')).toBe(true);
    expect(tiers.has('surface')).toBe(true);
  });

  it('papercusp-su has the four sections from the spec', () => {
    const su = domains.find((d) => d.id === 'papercusp-su');
    expect(su).toBeDefined();
    const ids = su!.sections.map((s) => s.id);
    expect(ids).toEqual(['coordination', 'file-locking', 'identity', 'tools']);
  });

  it('every section declares globs or runners', () => {
    for (const d of domains) {
      for (const s of d.sections) {
        const hasGlobs = (s.globs?.length ?? 0) > 0;
        const hasRunners = (s.runners?.length ?? 0) > 0;
        expect(hasGlobs || hasRunners, `${d.id}/${s.id}`).toBe(true);
      }
    }
  });

  it('every domain id is kebab-lowercase', () => {
    for (const d of domains) {
      expect(d.id, d.label).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('ui suite exposes the desktop stability regression tests in /admin/testing', () => {
    const plans = domains.find((d) => d.id === 'plans');
    expect(plans).toBeDefined();
    const ui = plans!.sections.find((s) => s.id === 'ui');
    expect(ui).toBeDefined();
    expect(ui!.globs).toEqual(expect.arrayContaining([
      'apps/operator/lib/__tests__/client-navigation.test.ts',
      'apps/operator/lib/__tests__/desktop-static-host.test.ts',
      'apps/operator/lib/__tests__/desktop-ui-intents.test.ts',
      'apps/operator/lib/__tests__/operator-vite-dev-mode.test.ts',
      'apps/operator/lib/__tests__/lazy-with-retry.test.ts',
      'apps/operator/lib/__tests__/navigation-progress-helpers.test.ts',
      'apps/operator/app/admin/testing/_lib/recorder-start-params.test.ts',
      'apps/operator/app/_components/__tests__/SupportChatButton.test.tsx',
      'apps/operator/app/_components/__tests__/ChatwootWidget.test.tsx',
      'apps/operator/app/_components/__tests__/OperatorChatSidebar.test.ts',
      'apps/operator/app/_components/__tests__/UiPresenceProvider.test.tsx',
      'apps/operator/app/_components/__tests__/UserPicker.test.tsx',
      'apps/operator/lib/__tests__/PluginIframe.test.tsx',
      'apps/operator/lib/__tests__/notify.test.ts',
      'apps/operator/lib/__tests__/workspaces-tauri.test.ts',
      'apps/operator/app/_components/__tests__/routePending.test.ts',
      'apps/operator/app/_components/__tests__/RouteLink.test.ts',
      'apps/operator/app/_components/__tests__/RouteProgressProvider.test.ts',
    ]));
  });
});

describe('Phase 1 — universal vs Papercusp split (testing-shell-cross-project D-007)', () => {
  it('universalDomains is the portable set [routes], all tier "universal"', () => {
    expect(universalDomains.map((d) => d.id).sort()).toEqual(['routes']);
    expect(universalDomains.every((d) => d.tier === 'universal')).toBe(true);
  });

  it('papercuspRegistry is the 27 Papercusp-only domains, none universal', () => {
    expect(papercuspRegistry.length).toBe(27);
    expect(papercuspRegistry.some((d) => d.tier === 'universal')).toBe(false);
    // the universal domains are NOT in the Papercusp set
    const papercuspIds = new Set(papercuspRegistry.map((d) => d.id));
    for (const g of universalDomains) expect(papercuspIds.has(g.id)).toBe(false);
  });

  it('the Papercusp-runtime-bound domains moved out of the lib into the operator', () => {
    const papercuspIds = new Set(papercuspRegistry.map((d) => d.id));
    for (const id of ['test-runs', 'live', 'chaos', 'ai']) expect(papercuspIds.has(id)).toBe(true);
  });

  it('adminRegistry composes both into the full 28', () => {
    expect(adminRegistry.length).toBe(28);
    expect(adminRegistry.length).toBe(universalDomains.length + papercuspRegistry.length);
  });

  it('the universal domains registered into the shared Map (admin getTestDomain sees them)', () => {
    const ids = new Set(listTestDomains().map((d) => d.id));
    for (const g of universalDomains) expect(ids.has(g.id)).toBe(true);
  });
});
