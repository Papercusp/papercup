import { useEffect, useState, type ReactNode } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { AdvTabId } from './AdvShell';
import { RealGitPanel } from '@/app/harness/dock/RealGitPanel';
import { BrainstormFull } from '@/app/harness/brainstorm/BrainstormFull';
import PrsTab from '@/app/harness/PrsTab';
import HarnessSettingsPanel from '@/app/harness/HarnessSettingsPanel';
import InsightsPanel from '@/app/harness/InsightsPanel';
import AdvConfigTab from '@/app/adv/harnesses/AdvConfigTab';
import AdvDocsTab from '@/app/adv/harnesses/AdvDocsTab';

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

// The /adv harness tab uses the staging phase throughout (mirrors the rest of
// the /adv harness surface — useHarnessData, AdvOverviewPanel).
const ADV_PHASE = 'staging';

/**
 * Insights wrapper. InsightsPanel needs the harness `status` payload (feature
 * list + mission cost/tokens/iteration); the legacy dashboard handed it down
 * from its own poll. Here we fetch `/status` ourselves so the panel mounts
 * standalone — no HarnessDashboard. Mirrors the props HarnessDashboard passed.
 */
function AdvInsightsTab({ slug }: { slug: string }) {
  // status is a loose JSON blob from /status; the legacy caller also treats
  // `status.features` as `any`.
  const [status, setStatus] = useState<any>(null);
  useEffect(() => {
    let cancel = false;
    setStatus(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=${ADV_PHASE}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancel) setStatus(j);
      })
      .catch(() => {
        if (!cancel) setStatus(null);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  if (!status) return <div className="pc-adv-harness-panel__empty">Loading insights…</div>;
  return (
    <InsightsPanel
      inline
      slug={slug}
      features={status.features ?? []}
      totalCostUsd={status.missionCostUsd ?? 0}
      totalInputTokens={status.missionInputTokens ?? 0}
      totalOutputTokens={status.missionOutputTokens ?? 0}
      iteration={status.iteration ?? 0}
      onClose={() => {}}
    />
  );
}

/**
 * Tabs whose body is a self-contained harness panel component. Every panel
 * renders its component DIRECTLY — the legacy `HarnessDashboard` monolith is
 * no longer mounted anywhere in /adv. (git has its own two-pane branch below;
 * docs renders the plugin's docs tab via AdvDocsTab.)
 */
const DIRECT: Partial<Record<AdvHarnessPanel, (slug: string) => ReactNode>> = {
  brainstorm: (slug) => <BrainstormFull slug={slug} />,
  prs: (slug) => <PrsTab harnessSlug={slug} />,
  settings: (slug) => <HarnessSettingsPanel slug={slug} phase={ADV_PHASE} />,
  insights: (slug) => <AdvInsightsTab slug={slug} />,
  config: (slug) => <AdvConfigTab slug={slug} />,
  docs: (slug) => <AdvDocsTab slug={slug} />,
};

const PANEL_FILL_CSS = `
  .pc-adv-harness-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .pc-adv-harness-panel > * {
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
`;

export default function AdvHarnessPanelPage({ panel }: { panel: AdvHarnessPanel }) {
  const [activeSlug] = useQueryState('slug', parseAsString);

  // Git keeps its bespoke two-pane layout: native git graph + a PRs pane.
  // The PRs pane now renders <PrsTab/> directly instead of an embedded
  // HarnessDashboard.
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
              <PrsTab harnessSlug={activeSlug} />
            </div>
          </div>
        ) : (
          <div className="pc-adv-harness-panel__empty">Select a harness to view its git graph.</div>
        )}
        <style>{`
          .pc-adv-harness-panel--git {
            padding: 10px;
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
          ${PANEL_FILL_CSS}
        `}</style>
      </section>
    );
  }

  // Decoupled tabs: render the panel component directly.
  const direct = DIRECT[panel];
  if (direct) {
    return (
      <section className="pc-adv-harness-panel" aria-label={`ADV ${ADV_HARNESS_PANEL_LABELS[panel]} workspace`}>
        {activeSlug ? direct(activeSlug) : <div className="pc-adv-harness-panel__empty">Select a harness.</div>}
        <style>{PANEL_FILL_CSS}</style>
      </section>
    );
  }

  // Every panel in the union is handled above (git branch + DIRECT registry),
  // so this is unreachable — a defensive guard that, crucially, never mounts
  // HarnessDashboard. /adv no longer depends on the monolith at all.
  return (
    <section className="pc-adv-harness-panel" aria-label={`ADV ${ADV_HARNESS_PANEL_LABELS[panel]} workspace`}>
      <div className="pc-adv-harness-panel__empty">Unknown panel: {panel}</div>
      <style>{PANEL_FILL_CSS}</style>
    </section>
  );
}
