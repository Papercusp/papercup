import type { AdvTabId } from './AdvShell';
import HarnessDashboard from '@/app/harness/HarnessDashboard';

type AdvHarnessPanel = Extract<AdvTabId, 'brainstorm' | 'prs' | 'insights' | 'config' | 'settings' | 'docs'>;

export const ADV_HARNESS_PANEL_LABELS: Record<AdvHarnessPanel, string> = {
  brainstorm: 'Brainstorm',
  prs: 'PRs',
  insights: 'Insights',
  config: 'Config',
  settings: 'Settings',
  docs: 'Docs',
};

export default function AdvHarnessPanelPage({ panel }: { panel: AdvHarnessPanel }) {

  return (
    <section className="pc-adv-harness-panel" aria-label={`ADV ${ADV_HARNESS_PANEL_LABELS[panel]} workspace`}>
      <HarnessDashboard forcedPanel={panel} embeddedPanelChrome />
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
        .pc-adv-harness-panel .h-root--embedded-panel .h-header,
        .pc-adv-harness-panel .h-root--embedded-panel .h-tab-strip,
        .pc-adv-harness-panel .h-root--embedded-panel .h-active-agents-row,
        .pc-adv-harness-panel .h-root--embedded-panel .h-plan-review-banner,
        .pc-adv-harness-panel .h-root--embedded-panel .h-quick-action-row,
        .pc-adv-harness-panel .h-root--embedded-panel .h-guide-strip {
          display: none !important;
        }
        .pc-adv-harness-panel .h-root--embedded-panel .h-main-shell {
          flex: 1;
          min-height: 0;
        }
      `}</style>
    </section>
  );
}
