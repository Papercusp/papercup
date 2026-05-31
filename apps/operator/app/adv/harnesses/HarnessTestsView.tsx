'use client';

import { useMemo } from 'react';
import { TestingShell, tabsFromRegistry } from '@papercusp/testing-shell';
import {
  harnessTestingRegistryFor,
  harnessTierLabelsFor,
  ACCEPTANCE_DOMAIN_ID,
} from '@/lib/harness-testing-registry';
import { makeHarnessTestingDataSource } from './harness-testing-data-source';
import AcceptancePanel from './AcceptancePanel';

/**
 * <HarnessTestsView> — the harness Tests surface: the shared <TestingShell>
 * with the harness registry (Built-in generalized domains + a Project/
 * Acceptance section) and a dataSource pointed at /api/harness/:slug/testing/*.
 *
 * Rendered as the top-level /adv "Tests" tab via AdvHarnessPanelPage's DIRECT
 * registry (same mechanism as Git/Docs/Config). It was briefly a harness dock
 * panel (AdvTestsPanel); promoted to its own main tab per user request, so the
 * dock registration was removed.
 *
 * `slug` is the /adv global active harness (passed from ?slug= by
 * AdvHarnessPanelPage); phase is the /adv staging default. The active subtab is
 * URL-backed under `testsTab` to avoid colliding with the /adv shell's `tab`.
 */
export default function HarnessTestsView({ slug }: { slug: string }) {
  // Self/dogfood harness (papercup) gets the full /admin/testing domain set;
  // generic harnesses get the Built-in generalized tier + Acceptance.
  const registry = useMemo(() => harnessTestingRegistryFor(slug), [slug]);
  const tabs = useMemo(() => tabsFromRegistry(registry), [registry]);
  const tierLabels = useMemo(() => harnessTierLabelsFor(slug), [slug]);
  const dataSource = useMemo(() => makeHarnessTestingDataSource(slug, 'staging'), [slug]);
  const customTabs = useMemo(
    () => ({ [ACCEPTANCE_DOMAIN_ID]: () => <AcceptancePanel slug={slug} /> }),
    [slug],
  );
  // Land on the first useful tab, not the empty/non-functional generalized tier
  // (its admin-suite runners aren't wired into the harness data-source, and its
  // globs are mostly empty here): the first Papercusp domain for the self
  // harness, or Acceptance for a generic harness.
  const defaultTabId = useMemo(
    () => (registry.find((d) => d.tier !== 'generalized') ?? registry[0])?.id,
    [registry],
  );

  return (
    <TestingShell
      tabs={tabs}
      tierLabels={tierLabels}
      dataSource={dataSource}
      customTabs={customTabs}
      defaultTabId={defaultTabId}
      sectionLabel="Tests"
      queryKey="testsTab"
    />
  );
}
