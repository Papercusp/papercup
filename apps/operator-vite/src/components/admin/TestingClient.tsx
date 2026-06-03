import type { ReactElement } from 'react';
// Shared id→panel map + the universal tab metadata (also used by the /adv harness Tests tab).
import { TESTING_CUSTOM_TABS, UNIVERSAL_TESTING_TABS } from '@/app/admin/testing/testing-custom-tabs';
import {
  TestingShell,
  adminTestingDataSource,
  type TestingShellTab,
} from '@papercusp/testing-shell';

/**
 * Testing-admin client — a thin wrapper over the shared <TestingShell>
 * (@papercusp/testing-shell). It supplies the admin tab list, tier labels, data
 * source, and the custom React panels.
 *
 * The universal panels (Live / Chaos-web / AI Explore / Chaos-desktop) are wired
 * ONCE in testing-custom-tabs.tsx via buildUniversalTesting (universal-testing-
 * domains-generic Phase 6) and surfaced here as UNIVERSAL_TESTING_TABS (re-tiered
 * into the "quick" group). The operator-specific tabs (Test Runs, Live metrics =
 * vitals, Memory, Routes, Packaged, LLM) keep their bespoke React; the remaining
 * domain/surface tabs render via <DomainTestPanel> driven by the
 * testing-domains registry (server-side).
 *
 * Testing tools are eagerly imported on purpose: this is the route used to
 * measure and orchestrate performance suites, so lazy chunk waterfalls only make
 * the framework itself slower to reason about.
 */

type TabId =
  // operator-specific (bespoke)
  | 'test-runs'
  | 'vitals'
  | 'routes'
  | 'packaged'
  | 'llm'
  | 'memory'
  // universal (from buildUniversalTesting)
  | 'live-web'
  | 'chaos-web'
  | 'ai-explore'
  | 'chaos-desktop'
  // domain (registry-driven)
  | 'harness'
  | 'voice'
  | 'papercusp-su'
  | 'dogfood'
  | 'backup'
  | 'plans'
  | 'operator'
  | 'design'
  | 'plugins'
  | 'snapshots'
  | 'mobile'
  | 'provisioning'
  // surface (registry-driven)
  | 'transport'
  | 'docs';

interface AdminTab extends TestingShellTab {
  id: TabId;
  tier: 'quick' | 'domain' | 'surface';
}

// The universal panels live in the "quick runs" group (they were the operator's
// quick-tier chaos/live/ai tabs before universalization).
const UNIVERSAL_QUICK: AdminTab[] = UNIVERSAL_TESTING_TABS.map(
  (t: TestingShellTab) => ({ ...t, tier: 'quick' }) as AdminTab,
);

const TABS: AdminTab[] = [
  // ── Tier 1: Quick runs ──
  { id: 'test-runs', label: 'Test Runs', hint: 'suite orchestrator', tier: 'quick' },
  // Operator desktop vitals (voice spend / lock queue / in-shell observer). Renamed
  // from `live` → `vitals`; the universal in-page observer owns `live-web`.
  { id: 'vitals', label: 'Live metrics', hint: 'passive observer (desktop)', tier: 'quick', platform: 'desktop' },
  { id: 'memory', label: 'Memory', hint: 'mem0 health + suite', tier: 'quick' },
  // ── Universal panels (Live / Chaos-web / AI Explore / Chaos-desktop) ──
  ...UNIVERSAL_QUICK,
  { id: 'packaged', label: 'Packaged build', hint: 'wdio + tauri-driver', tier: 'quick' },

  // ── Tier 2: Domains ──
  { id: 'harness', label: 'Harness', hint: 'dock, layout, fs', tier: 'domain' },
  { id: 'voice', label: 'Voice', hint: 'cards, engines, persona', tier: 'domain' },
  { id: 'papercusp-su', label: 'Papercusp-SU', hint: 'coord, locks, identity, tools', tier: 'domain' },
  { id: 'dogfood', label: 'Dogfood', hint: 'substrate, federation, claims, PRs', tier: 'domain' },
  { id: 'backup', label: 'Backup', hint: 'kopia integration', tier: 'domain' },
  { id: 'plans', label: 'Plans', hint: 'authoring, runs, revisions', tier: 'domain' },
  { id: 'operator', label: 'Operator', hint: 'brain, cards, scan', tier: 'domain' },
  { id: 'design', label: 'Design', hint: 'IR, spec, tokens', tier: 'domain' },
  { id: 'plugins', label: 'Plugins', hint: 'loader, SDK, WIT', tier: 'domain' },
  { id: 'snapshots', label: 'Snapshots', hint: 'shape, fork, export', tier: 'domain' },
  { id: 'mobile', label: 'Mobile', hint: 'pair, JWT, feeds', tier: 'domain' },
  { id: 'provisioning', label: 'Provisioning', hint: 'runner, sandbox, trust', tier: 'domain' },
  { id: 'llm', label: 'LLM', hint: 'scenario judging', tier: 'domain' },

  // ── Tier 3: Surfaces ──
  { id: 'routes', label: 'Routes', hint: 'per-route roll-up', tier: 'surface' },
  { id: 'transport', label: 'Transport', hint: 'SSE, IPC, adapters', tier: 'surface' },
  { id: 'docs', label: 'Docs', hint: 'engine, outline, search', tier: 'surface' },
];

const TIER_LABELS: Record<AdminTab['tier'], string> = {
  quick: 'Quick runs',
  domain: 'Domains',
  surface: 'Surfaces',
};

export default function TestingClient(): ReactElement {
  return (
    <TestingShell
      tabs={TABS}
      tierLabels={TIER_LABELS}
      dataSource={adminTestingDataSource}
      customTabs={TESTING_CUSTOM_TABS}
      defaultTabId="test-runs"
      platform="both"
    />
  );
}
