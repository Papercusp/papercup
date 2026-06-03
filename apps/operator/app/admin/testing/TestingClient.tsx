'use client';

import { useQueryState, parseAsStringEnum } from 'nuqs';
import { TESTING_CUSTOM_TABS, UNIVERSAL_TESTING_TABS } from './testing-custom-tabs';

/**
 * Retired Next-surface testing client. The LIVE /admin/testing is the
 * operator-vite `components/admin/TestingClient`; this thin variant is kept
 * building by delegating to the shared `TESTING_CUSTOM_TABS` (universal panels
 * via buildUniversalTesting + operator-specific) so it never re-imports the
 * deleted bespoke ChaosTab/AIExploreTab. universal-testing-domains-generic Phase 6.
 */
const TABS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'test-runs', label: 'Test Runs', hint: 'suite orchestrator' },
  { id: 'vitals', label: 'Live metrics', hint: 'passive observer (desktop)' },
  { id: 'memory', label: 'Memory', hint: 'mem0 health + suite' },
  ...UNIVERSAL_TESTING_TABS.map((t) => ({ id: t.id, label: t.label, hint: t.hint ?? '' })),
  { id: 'routes', label: 'Routes', hint: 'per-route roll-up' },
  { id: 'packaged', label: 'Packaged build', hint: 'wdio + tauri-driver' },
  { id: 'llm', label: 'LLM', hint: 'scenario-driven judging' },
];

const TAB_IDS = TABS.map((t) => t.id);

export default function TestingClient() {
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsStringEnum<string>(TAB_IDS).withDefault('test-runs'),
  );
  const Panel = TESTING_CUSTOM_TABS[tab] ?? TESTING_CUSTOM_TABS['test-runs'];

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
        <Panel />
      </main>
    </div>
  );
}
