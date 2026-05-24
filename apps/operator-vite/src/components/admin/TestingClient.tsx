import { useQueryState, parseAsStringEnum } from 'nuqs';
import ChaosTab from '@/app/admin/testing/_components/ChaosTab';
import AIExploreTab from '@/app/admin/testing/_components/AIExploreTab';
import LiveMetricsTab from '@/app/admin/testing/_components/LiveMetricsTab';
import RoutesTab from '@/app/admin/testing/_components/RoutesTab';
import PackagedBuildTab from '@/app/admin/testing/_components/PackagedBuildTab';
import LlmTab from '@/app/admin/testing/_components/LlmTab';
import TestRunsTab from '@/app/admin/testing/_components/TestRunsTab';
import MemoryTab from '@/app/admin/testing/_components/MemoryTab';

/**
 * Testing-admin client — translated from
 * `apps/operator/app/admin/testing/TestingClient.tsx` (B-2).
 *
 * Testing tools are now eagerly imported on purpose: this is the route used to
 * measure and orchestrate performance suites, so lazy chunk waterfalls here
 * only make the framework itself slower and harder to reason about.
 */
type TabId = 'test-runs' | 'chaos' | 'ai' | 'live' | 'routes' | 'packaged' | 'llm' | 'memory';

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'test-runs', label: 'Test Runs', hint: 'suite orchestrator' },
  { id: 'live', label: 'Live metrics', hint: 'passive observer' },
  { id: 'memory', label: 'Memory', hint: 'mem0 health + suite' },
  { id: 'chaos', label: 'Chaos', hint: 'autonomous clicker' },
  { id: 'ai', label: 'AI Explore', hint: 'LLM-driven walk' },
  { id: 'routes', label: 'Routes', hint: 'per-route roll-up' },
  { id: 'packaged', label: 'Packaged build', hint: 'wdio + tauri-driver' },
  { id: 'llm', label: 'LLM', hint: 'scenario-driven judging' },
];

export default function TestingClient() {
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsStringEnum<TabId>(['test-runs', 'chaos', 'ai', 'live', 'routes', 'packaged', 'llm', 'memory']).withDefault('test-runs'),
  );

  return (
    <div className="pc-test-shell">
      <aside className="pc-test-left">
        <h2 className="pc-test-section-label">Testing</h2>
        <nav aria-label="Testing tabs">
          {TABS.map((t) => (
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
        </nav>
      </aside>
      <main className="pc-test-main">
        {tab === 'test-runs' && <TestRunsTab />}
        {tab === 'live' && <LiveMetricsTab />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'chaos' && <ChaosTab />}
        {tab === 'ai' && <AIExploreTab />}
        {tab === 'routes' && <RoutesTab />}
        {tab === 'packaged' && <PackagedBuildTab />}
        {tab === 'llm' && <LlmTab />}
      </main>
    </div>
  );
}
