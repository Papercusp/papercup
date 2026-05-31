import type { ReactElement } from 'react';
// Shared id→bespoke-panel map (also used by the /adv harness Tests tab).
import { TESTING_CUSTOM_TABS } from '@/app/admin/testing/testing-custom-tabs';
import {
  TestingShell,
  adminTestingDataSource,
  type TestingShellTab,
} from '@papercusp/testing-shell';

/**
 * Testing-admin client — now a thin wrapper over the shared
 * <TestingShell> (@papercusp/testing-shell). The shell (left-rail +
 * panel host) was extracted in P-003 of
 * harness-tests-tab-and-tester-promotion-2026-05-26; this file supplies
 * the admin-specific tab list, tier labels, data source, and the 8
 * bespoke React tabs that can't live in the lib.
 *
 * Original plan: admin-testing-tab-restructure-2026-05-24, Phase 1.
 *
 * 21 tabs in three tiers:
 *  - quick:   one-click suite runners + observers (existing 8 + packaged)
 *  - domain:  per-domain test surfaces (12 of 13 new tabs)
 *  - surface: cross-cutting transports (routes, transport, docs)
 *
 * The 8 existing tabs (test-runs, live, memory, chaos, ai, routes,
 * packaged, llm) keep their bespoke React via `customTabs`; the new 13
 * tabs render via the shell's <DomainTestPanel> driven by the
 * testing-domains registry (server-side).
 *
 * Testing tools are eagerly imported on purpose: this is the route used
 * to measure and orchestrate performance suites, so lazy chunk
 * waterfalls only make the framework itself slower to reason about.
 */

type TabId =
  // existing (bespoke)
  | 'test-runs'
  | 'chaos'
  | 'ai'
  | 'live'
  | 'routes'
  | 'packaged'
  | 'llm'
  | 'memory'
  // domain (registry-driven)
  | 'harness'
  | 'voice'
  | 'papercusp-su'
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

const TABS: AdminTab[] = [
  // ── Tier 1: Quick runs ──
  { id: 'test-runs', label: 'Test Runs', hint: 'suite orchestrator', tier: 'quick' },
  { id: 'live', label: 'Live metrics', hint: 'passive observer', tier: 'quick' },
  { id: 'memory', label: 'Memory', hint: 'mem0 health + suite', tier: 'quick' },
  { id: 'chaos', label: 'Chaos', hint: 'autonomous clicker', tier: 'quick' },
  { id: 'ai', label: 'AI Explore', hint: 'LLM-driven walk', tier: 'quick' },
  { id: 'packaged', label: 'Packaged build', hint: 'wdio + tauri-driver', tier: 'quick' },

  // ── Tier 2: Domains ──
  { id: 'harness', label: 'Harness', hint: 'dock, layout, fs', tier: 'domain' },
  { id: 'voice', label: 'Voice', hint: 'cards, engines, persona', tier: 'domain' },
  { id: 'papercusp-su', label: 'Papercusp-SU', hint: 'coord, locks, identity, tools', tier: 'domain' },
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
    />
  );
}
