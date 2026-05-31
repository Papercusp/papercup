'use client';

import { useEffect, useMemo, useState } from 'react';
import { TestingShell, tabsFromRegistry } from '@papercusp/testing-shell';
import {
  harnessTestingRegistry,
  HARNESS_TESTING_TIER_LABELS,
  ACCEPTANCE_DOMAIN_ID,
} from '@/lib/harness-testing-registry';
import { type TestDomain } from '@/lib/testing-domains';
import { makeHarnessTestingDataSource } from './harness-testing-data-source';
import AcceptancePanel from './AcceptancePanel';

/**
 * <HarnessTestsView> — the harness Tests surface: the shared <TestingShell>
 * with the dataSource pointed at /api/harness/:slug/testing/*.
 *
 * The domain nav is HARNESS-OWNED data, not hard-wired in the operator: it is
 * fetched from GET /api/harness/:slug/testing/domains, which reads the harness's
 * own `<worktree>/.harness/testing-domains.json` contract (falling back to the
 * generic Built-in + Acceptance set when a harness declares none). The papercup
 * dogfood harness ships that file generated from the operator's adminRegistry,
 * so its Tests tab surfaces every test domain through the same path any harness
 * would — the place a harness's test data naturally lives.
 *
 * Rendered as the top-level /adv "Tests" tab via AdvHarnessPanelPage's DIRECT
 * registry. `slug` is the /adv global active harness; phase is the staging
 * default. The active subtab is URL-backed under `testsTab`.
 */
export default function HarnessTestsView({ slug }: { slug: string }) {
  const [declared, setDeclared] = useState<
    { domains: TestDomain[]; tierLabels: Record<string, string> } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    setDeclared(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/testing/domains?phase=staging`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`domains ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        const domains =
          Array.isArray(d?.domains) && d.domains.length
            ? (d.domains as TestDomain[])
            : harnessTestingRegistry;
        setDeclared({ domains, tierLabels: d?.tierLabels ?? HARNESS_TESTING_TIER_LABELS });
      })
      .catch(() => {
        if (!cancelled)
          setDeclared({ domains: harnessTestingRegistry, tierLabels: HARNESS_TESTING_TIER_LABELS });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const domains = declared?.domains ?? harnessTestingRegistry;
  const tierLabels = declared?.tierLabels ?? HARNESS_TESTING_TIER_LABELS;
  const tabs = useMemo(() => tabsFromRegistry(domains), [domains]);
  const dataSource = useMemo(() => makeHarnessTestingDataSource(slug, 'staging'), [slug]);
  const customTabs = useMemo(
    () => ({ [ACCEPTANCE_DOMAIN_ID]: () => <AcceptancePanel slug={slug} /> }),
    [slug],
  );
  // Land on the first useful (non-generalized) tab. The generalized "Built-in"
  // tier is mostly empty / non-functional in the harness context (its
  // admin-suite runners aren't wired into the harness data-source).
  const defaultTabId = useMemo(
    () => (domains.find((d) => d.tier !== 'generalized') ?? domains[0])?.id,
    [domains],
  );

  // Gate render until the harness's domains resolve, so TestingShell doesn't
  // lock a fallback default tab into the URL before the real nav arrives.
  if (!declared) {
    return <div style={{ padding: 16, color: 'var(--fg-mute)', fontSize: 13 }}>Loading tests…</div>;
  }

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
