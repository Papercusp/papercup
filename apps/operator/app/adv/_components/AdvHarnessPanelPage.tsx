'use client';

import { useEffect } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import HarnessDashboard from '../../harness/HarnessDashboard';

type AdvHarnessPanel = 'brainstorm' | 'prs' | 'insights' | 'config' | 'settings' | 'docs';

const PANEL_LABELS: Record<AdvHarnessPanel, string> = {
  brainstorm: 'Brainstorm',
  prs: 'PRs',
  insights: 'Insights',
  config: 'Config',
  settings: 'Settings',
  docs: 'Docs',
};

/**
 * Transitional bridge while /adv absorbs the legacy /harness workspace.
 *
 * The legacy dashboard already owns the harness selector, URL-backed ?slug=
 * state, plugin-tab resolution (including docs), and the mature bodies for
 * these pages. Each /adv tab pins the dashboard's ?panel= value to the page
 * being visited so the new ADV shell can become the primary navigation while
 * the old /harness route remains available behind its existing URL.
 */
export default function AdvHarnessPanelPage({ panel }: { panel: AdvHarnessPanel }) {
  const [activePanel, setActivePanel] = useQueryState('panel', parseAsString.withDefault(panel));

  useEffect(() => {
    // The legacy docs panel is plugin-backed: HarnessDashboard resolves
    // ?panel=docs to plugin:<tabId> once harness plugin contributions load.
    // Do not fight that canonicalization on /adv/docs.
    if (panel === 'docs' && activePanel?.startsWith('plugin:')) return;
    if (activePanel !== panel) void setActivePanel(panel);
  }, [activePanel, panel, setActivePanel]);

  return (
    <section className="pc-adv-harness-panel" aria-label={`ADV ${PANEL_LABELS[panel]} workspace`}>
      <HarnessDashboard />
      <style jsx global>{`
        .pc-adv-harness-panel {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .pc-adv-harness-panel > .h-root {
          flex: 1;
          min-height: 0;
        }
      `}</style>
    </section>
  );
}
