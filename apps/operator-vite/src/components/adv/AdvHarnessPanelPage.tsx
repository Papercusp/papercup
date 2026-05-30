import { parseAsString, useQueryState } from 'nuqs';
import type { AdvTabId } from './AdvShell';
import HarnessDashboard from '@/app/harness/HarnessDashboard';
import { RealGitPanel } from '@/app/harness/dock/RealGitPanel';

type AdvHarnessPanel = Extract<AdvTabId, 'brainstorm' | 'prs' | 'insights' | 'config' | 'settings' | 'docs' | 'git'>;

export const ADV_HARNESS_PANEL_LABELS: Record<AdvHarnessPanel, string> = {
  brainstorm: 'Brainstorm',
  prs: 'PRs',
  insights: 'Insights',
  config: 'Config',
  settings: 'Settings',
  docs: 'Docs',
  git: 'Git',
};

export default function AdvHarnessPanelPage({ panel }: { panel: AdvHarnessPanel }) {
  const [activeSlug] = useQueryState('slug', parseAsString);

  if (panel === 'git') {
    return (
      <section className="pc-adv-harness-panel pc-adv-harness-panel--git" aria-label="ADV Git workspace">
        {activeSlug ? (
          <div className="pc-adv-git-split">
            <div className="pc-adv-git-split__pane" aria-label="Git graph">
              <RealGitPanel
                panelId="adv-git"
                panelType="data:git"
                params={{ harnessSlug: activeSlug }}
                api={{
                  setParams: () => {},
                  setTitle: () => {},
                  close: () => {},
                }}
              />
            </div>
            <div className="pc-adv-git-split__pane pc-adv-git-split__pane--prs" aria-label="Pull requests">
              <HarnessDashboard forcedPanel="prs" embeddedPanelChrome />
            </div>
          </div>
        ) : (
          <div className="pc-adv-harness-panel__empty">Select a harness to view its git graph.</div>
        )}
        <style>{`
          .pc-adv-harness-panel {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
          }
          .pc-adv-harness-panel--git {
            padding: 10px;
          }
          .pc-adv-harness-panel--git > * {
            flex: 1;
            min-height: 0;
          }
          /* Two panes side by side: git graph (left) + PRs (right). */
          .pc-adv-git-split {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            min-height: 0;
          }
          .pc-adv-git-split__pane {
            min-width: 0;
            min-height: 0;
            display: flex;
            flex-direction: column;
            border: 1px solid var(--border, rgba(125, 211, 252, 0.15));
            border-radius: 10px;
            overflow: hidden;
            background: var(--bg-2, rgba(255, 255, 255, 0.02));
          }
          .pc-adv-git-split__pane > * {
            flex: 1;
            min-height: 0;
          }
          /* Hide the embedded HarnessDashboard chrome inside the PR pane —
             same suppression the non-git panels use. */
          .pc-adv-git-split__pane--prs .h-root--embedded-panel .h-header,
          .pc-adv-git-split__pane--prs .h-root--embedded-panel .h-tab-strip,
          .pc-adv-git-split__pane--prs .h-root--embedded-panel .h-active-agents-row,
          .pc-adv-git-split__pane--prs .h-root--embedded-panel .h-guide-strip {
            display: none !important;
          }
          .pc-adv-git-split__pane--prs .h-root--embedded-panel .h-main-shell {
            flex: 1;
            min-height: 0;
          }
          .pc-adv-harness-panel__empty {
            display: grid;
            place-items: center;
            min-height: 220px;
            color: var(--fg-mute, #7f9bb4);
            font-size: 13px;
          }
        `}</style>
      </section>
    );
  }

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
