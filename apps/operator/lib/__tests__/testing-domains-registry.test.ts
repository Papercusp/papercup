/**
 * Smoke test: registry imports cleanly + every domain is well-shaped.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-002 verification.
 */

import { describe, expect, it } from 'vitest';
import './_loads-registry'; // side-effect import to populate the registry
import { listTestDomains } from '../testing-domains';

describe('testing-domains-registry', () => {
  const domains = listTestDomains();

  it('registers exactly 21 domains', () => {
    expect(domains.length).toBe(21);
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
      'apps/operator/app/_components/__tests__/UiPresenceProvider.test.tsx',
      'apps/operator/app/_components/__tests__/UserPicker.test.tsx',
      'apps/operator/lib/__tests__/PluginIframe.test.tsx',
    ]));
  });
});
