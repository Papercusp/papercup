'use client';

import { useMemo } from 'react';
import { TestingShell, tabsFromRegistry } from '@papercusp/testing-shell';
import {
  harnessTestingRegistry,
  HARNESS_TESTING_TIER_LABELS,
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
  const tabs = useMemo(() => tabsFromRegistry(harnessTestingRegistry), []);
  const dataSource = useMemo(() => makeHarnessTestingDataSource(slug, 'staging'), [slug]);
  const customTabs = useMemo(
    () => ({ [ACCEPTANCE_DOMAIN_ID]: () => <AcceptancePanel slug={slug} /> }),
    [slug],
  );

  return (
    <TestingShell
      tabs={tabs}
      tierLabels={HARNESS_TESTING_TIER_LABELS}
      dataSource={dataSource}
      customTabs={customTabs}
      defaultTabId={tabs[0]?.id}
      sectionLabel="Tests"
      queryKey="testsTab"
    />
  );
}
