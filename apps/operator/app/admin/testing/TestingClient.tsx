'use client';

import { Suspense } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import dynamic from 'next/dynamic';

const ChaosTab = dynamic(() => import('./_components/ChaosTab'), { ssr: false });
const AIExploreTab = dynamic(() => import('./_components/AIExploreTab'), { ssr: false });
const LiveMetricsTab = dynamic(() => import('./_components/LiveMetricsTab'), { ssr: false });
const RoutesTab = dynamic(() => import('./_components/RoutesTab'), { ssr: false });
const PackagedBuildTab = dynamic(() => import('./_components/PackagedBuildTab'), { ssr: false });
const LlmTab = dynamic(() => import('./_components/LlmTab'), { ssr: false });
const TestRunsTab = dynamic(() => import('./_components/TestRunsTab'), { ssr: false });

type TabId = 'test-runs' | 'chaos' | 'ai' | 'live' | 'routes' | 'packaged' | 'llm';

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'test-runs', label: 'Test Runs', hint: 'suite orchestrator' },
  { id: 'live', label: 'Live metrics', hint: 'passive observer' },
  { id: 'chaos', label: 'Chaos', hint: 'autonomous clicker' },
  { id: 'ai', label: 'AI Explore', hint: 'LLM-driven walk' },
  { id: 'routes', label: 'Routes', hint: 'per-route roll-up' },
  { id: 'packaged', label: 'Packaged build', hint: 'wdio + tauri-driver' },
  { id: 'llm', label: 'LLM', hint: 'scenario-driven judging' },
];

export default function TestingClient() {
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsStringEnum<TabId>(['test-runs', 'chaos', 'ai', 'live', 'routes', 'packaged', 'llm']).withDefault('test-runs'),
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
        <Suspense fallback={<div className="pc-test-loading">loading…</div>}>
          {tab === 'test-runs' && <TestRunsTab />}
          {tab === 'live' && <LiveMetricsTab />}
          {tab === 'chaos' && <ChaosTab />}
          {tab === 'ai' && <AIExploreTab />}
          {tab === 'routes' && <RoutesTab />}
          {tab === 'packaged' && <PackagedBuildTab />}
          {tab === 'llm' && <LlmTab />}
        </Suspense>
      </main>
    </div>
  );
}
