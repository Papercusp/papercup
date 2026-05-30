'use client';

import { useMemo } from 'react';
import { TestingShell, tabsFromRegistry } from '@papercusp/testing-shell';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { type Phase } from '@/lib/harness-phases';
import {
  harnessTestingRegistry,
  HARNESS_TESTING_TIER_LABELS,
} from '@/lib/harness-testing-registry';
import { makeHarnessTestingDataSource } from './harness-testing-data-source';

/**
 * <AdvTestsPanel> — the harness "Tests" tab, an /adv dock panel.
 *
 * Phase C (P-020/P-021/P-022) of
 * harness-tests-tab-and-tester-promotion-2026-05-26 — retargeted onto the
 * /adv dock (the original HarnessDashboard tab was deleted by the adv
 * migration). Renders the shared <TestingShell> with the harness registry
 * (Built-in generalized domains + a Project/Acceptance section) and a
 * dataSource pointed at /api/harness/:slug/testing/*.
 *
 * Reads `harnessSlug` + `phase` from dock params (same idiom as
 * AdvOverviewPanel). The active subtab is URL-backed under `testsTab` to
 * avoid colliding with the /adv shell's own `tab` param.
 */
export default function AdvTestsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const phase = ((params.phase as Phase) ?? 'staging') as Phase;

  const tabs = useMemo(() => tabsFromRegistry(harnessTestingRegistry), []);
  const dataSource = useMemo(
    () => makeHarnessTestingDataSource(slug, phase),
    [slug, phase],
  );

  if (!slug) return <div className="pc-adv-ov__empty">No harness slug in params.</div>;

  return (
    <TestingShell
      tabs={tabs}
      tierLabels={HARNESS_TESTING_TIER_LABELS}
      dataSource={dataSource}
      defaultTabId={tabs[0]?.id}
      sectionLabel="Tests"
      queryKey="testsTab"
    />
  );
}
