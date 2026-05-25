import { useEffect } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import AdvShell from './AdvShell';
import HarnessDashboard from '@/app/harness/HarnessDashboard';

type AdvHarnessPanel = 'brainstorm' | 'prs' | 'insights' | 'config' | 'settings' | 'docs';

const PANEL_LABELS: Record<AdvHarnessPanel, string> = {
  brainstorm: 'Brainstorm',
  prs: 'PRs',
  insights: 'Insights',
  config: 'Config',
  settings: 'Settings',
  docs: 'Docs',
};

export default function AdvHarnessPanelPage({ panel }: { panel: AdvHarnessPanel }) {
  const [activePanel, setActivePanel] = useQueryState('panel', parseAsString.withDefault(panel));

  useEffect(() => {
    // The docs body is currently plugin-backed: HarnessDashboard resolves
    // ?panel=docs to plugin:<tabId> when the selected harness contributes docs.
    if (panel === 'docs' && activePanel?.startsWith('plugin:')) return;
    if (activePanel !== panel) void setActivePanel(panel);
  }, [activePanel, panel, setActivePanel]);

  return (
    <AdvShell title={PANEL_LABELS[panel]}>
      <section className="pc-adv-harness-panel" aria-label={`ADV ${PANEL_LABELS[panel]} workspace`}>
        <HarnessDashboard />
        <style>{`
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
    </AdvShell>
  );
}
