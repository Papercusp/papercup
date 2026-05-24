import { useQueryState, parseAsStringEnum } from 'nuqs';
import ChaosTab from '@/app/admin/testing/_components/ChaosTab';
import AIExploreTab from '@/app/admin/testing/_components/AIExploreTab';
import LiveMetricsTab from '@/app/admin/testing/_components/LiveMetricsTab';
import RoutesTab from '@/app/admin/testing/_components/RoutesTab';
import PackagedBuildTab from '@/app/admin/testing/_components/PackagedBuildTab';
import LlmTab from '@/app/admin/testing/_components/LlmTab';
import TestRunsTab from '@/app/admin/testing/_components/TestRunsTab';
import MemoryTab from '@/app/admin/testing/_components/MemoryTab';
import DomainTestPanel from './testing/DomainTestPanel';

/**
 * Testing-admin client.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, Phase 1.
 *
 * 21 tabs in three tiers:
 *  - quick:   one-click suite runners + observers (existing 8 + packaged)
 *  - domain:  per-domain test surfaces (12 of 13 new tabs)
 *  - surface: cross-cutting transports (routes, transport, docs)
 *
 * Existing 8 tabs (test-runs, live, memory, chaos, ai, routes, packaged,
 * llm) keep their bespoke React; the new 13 tabs render via shared
 * <DomainTestPanel> driven by the testing-domains registry.
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

interface TabEntry {
  id: TabId;
  label: string;
  hint: string;
  tier: 'quick' | 'domain' | 'surface';
}

const TABS: TabEntry[] = [
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

const TAB_IDS = TABS.map((t) => t.id) as [TabId, ...TabId[]];

const TIER_LABELS: Record<TabEntry['tier'], string> = {
  quick: 'Quick runs',
  domain: 'Domains',
  surface: 'Surfaces',
};

/**
 * Lookup from existing-tab id → bespoke React component (P-006a).
 * Tabs not listed render via <DomainTestPanel domainId={tab}/>.
 */
const CUSTOM_TABS: Partial<Record<TabId, () => JSX.Element>> = {
  'test-runs': TestRunsTab,
  live: LiveMetricsTab,
  memory: MemoryTab,
  chaos: ChaosTab,
  ai: AIExploreTab,
  routes: RoutesTab,
  packaged: PackagedBuildTab,
  llm: LlmTab,
};

function groupedTabs(): Array<{ tier: TabEntry['tier']; tabs: TabEntry[] }> {
  const groups: Array<{ tier: TabEntry['tier']; tabs: TabEntry[] }> = [];
  for (const tier of ['quick', 'domain', 'surface'] as const) {
    const tabs = TABS.filter((t) => t.tier === tier);
    if (tabs.length) groups.push({ tier, tabs });
  }
  return groups;
}

export default function TestingClient() {
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsStringEnum<TabId>(TAB_IDS).withDefault('test-runs'),
  );

  const CustomComponent = CUSTOM_TABS[tab];

  return (
    <div className="pc-test-shell">
      <aside className="pc-test-left">
        <h2 className="pc-test-section-label">Testing</h2>
        <nav aria-label="Testing tabs">
          {groupedTabs().map(({ tier, tabs }) => (
            <div key={tier} className="pc-test-tab-group">
              <div className="pc-test-tier-label">{TIER_LABELS[tier]}</div>
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`pc-test-tab ${tab === t.id ? 'is-active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  <span className="pc-test-tab-label">{t.label}</span>
                  <span className="pc-test-tab-hint">{t.hint}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="pc-test-main">
        {CustomComponent ? <CustomComponent /> : <DomainTestPanel domainId={tab} />}
      </main>
    </div>
  );
}
