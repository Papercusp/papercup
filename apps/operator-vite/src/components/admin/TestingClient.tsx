import { Suspense, lazy } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';

/**
 * Testing-admin client — translated from
 * `apps/operator/app/admin/testing/TestingClient.tsx` (B-2).
 *
 * next → TSR diff:
 *   - `dynamic(() => import('X'), { ssr: false })` → `lazy(() => import('X'))`.
 *     `ssr: false` is a no-op in a Vite SPA (no SSR). Existing Suspense
 *     boundary handles the loading state.
 *
 * Children live under the operator workspace (clean, no next/* imports);
 * imported via the `@` alias.
 */
const ChaosTab = lazy(() => import('@/app/admin/testing/_components/ChaosTab'));
const AIExploreTab = lazy(() => import('@/app/admin/testing/_components/AIExploreTab'));
const LiveMetricsTab = lazy(() => import('@/app/admin/testing/_components/LiveMetricsTab'));
const RoutesTab = lazy(() => import('@/app/admin/testing/_components/RoutesTab'));
const PackagedBuildTab = lazy(() => import('@/app/admin/testing/_components/PackagedBuildTab'));
const LlmTab = lazy(() => import('@/app/admin/testing/_components/LlmTab'));

type TabId = 'chaos' | 'ai' | 'live' | 'routes' | 'packaged' | 'llm';

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
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
    parseAsStringEnum<TabId>(['chaos', 'ai', 'live', 'routes', 'packaged', 'llm']).withDefault('live'),
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
