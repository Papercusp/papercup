import { useEffect, useState, type ReactNode } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { HARNESS_SCOPE_MODES, type HarnessScopeMode } from '@papercusp/operator-core/lib/harness/scope';
import type { AdvTabId } from './AdvShell';
import { useLexicon } from '@/lib/useLexicon';
import AdvGitWorkspace from '@/app/adv/harnesses/AdvGitWorkspace';
import { BrainstormFull } from '@/app/harness/brainstorm/BrainstormFull';
import PrsTab from '@/app/harness/PrsTab';
import HarnessSettingsPanel from '@/app/harness/HarnessSettingsPanel';
import BlueprintSettingsPanel from '@/app/harness/BlueprintSettingsPanel';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';
import { InsightsTab, type InsightsTabProps } from '@/app/harness/insights/InsightsTab';
import AdvDocsTab from '@/app/adv/harnesses/AdvDocsTab';
import HarnessTestsView from '@/app/adv/harnesses/HarnessTestsView';

type AdvHarnessPanel = Extract<AdvTabId, 'brainstorm' | 'prs' | 'insights' | 'settings' | 'docs' | 'git' | 'testing'>;

export const ADV_HARNESS_PANEL_LABELS: Record<AdvHarnessPanel, string> = {
  brainstorm: 'Brainstorm',
  prs: 'PRs',
  insights: 'Insights',
  settings: 'Settings',
  docs: 'Docs',
  git: 'Git',
  testing: 'Tests',
};

// The /adv harness tab uses the staging phase throughout (mirrors the rest of
// the /adv harness surface — useHarnessData, AdvOverviewPanel).
const ADV_PHASE = 'staging';

/**
 * Insights tab — Phase 8 six-card InsightsTab (P-073): Project, Activity feed,
 * People, Your place, How it works here, Spend. This is the same surface the
 * standalone `/harness/$slug/insights` route renders; we mirror its
 * fetch-then-render here so the live /adv Insights tab shows it too (replacing
 * the legacy cost/tokens InsightsPanel that the now-deleted HarnessDashboard
 * used to host). The endpoint returns `{ insights: InsightsTabProps }` —
 * pre-computed per-card props from loadHarnessInsights — so this is a thin
 * fetch wrapper.
 */
function AdvInsightsTab({ slug }: { slug: string }) {
  const [insights, setInsights] = useState<InsightsTabProps | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    setInsights(null);
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/insights`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { insights?: InsightsTabProps }) => {
        if (cancel) return;
        if (body?.insights) setInsights(body.insights);
        else setError('insights payload missing');
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  if (error) {
    return <div className="pc-adv-harness-panel__empty">Could not load insights: {error}</div>;
  }
  if (!insights) {
    return <div className="pc-adv-harness-panel__empty">Loading insights…</div>;
  }
  return <InsightsTab {...insights} />;
}

/**
 * Settings tab — flag-gated swap (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09
 * P-008/P-009): the SCHEMA-DRIVEN `BlueprintSettingsPanel` (renders from the harness
 * blueprint's declared `params`) when `BLUEPRINT_AWARE_SETTINGS` is on, else the legacy
 * hardcoded `HarnessSettingsPanel`. Either way the panel is PER-HARNESS — keyed by the
 * selected `?harness=` member slug — so this is the per-harness settings location inside
 * the harness/hive tab (P-009).
 */
function SettingsTab({ slug }: { slug: string }) {
  const blueprintAware = useFlag(FLAGS.BLUEPRINT_AWARE_SETTINGS);
  return blueprintAware ? (
    <BlueprintSettingsPanel slug={slug} phase={ADV_PHASE} />
  ) : (
    <HarnessSettingsPanel slug={slug} phase={ADV_PHASE} />
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
  settings: (slug) => <SettingsTab slug={slug} />,
  insights: (slug) => <AdvInsightsTab slug={slug} />,
  docs: (slug) => <AdvDocsTab slug={slug} />,
  testing: (slug) => <HarnessTestsView slug={slug} />,
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
  const t = useLexicon();
  const [activeSlug] = useQueryState('slug', parseAsString);
  const [scopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault('expanded'),
  );

  // "All Pots" has no single target, and these panels are inherently per-pot
  // (one brainstorm canvas, one PR list, one git repo, one docs tree). AdvShell
  // now keeps the active per-pot tab PINNED under all-mode (no snap-back to
  // Overview), so this is the steady-state "pick a hive from the dropdown"
  // prompt for that view (owner ask 2026-06-17).
  if (scopeMode === 'all') {
    return (
      <section className="pc-adv-harness-panel" aria-label={`ADV ${ADV_HARNESS_PANEL_LABELS[panel]} workspace`}>
        <div className="pc-adv-harness-panel__empty">
          {ADV_HARNESS_PANEL_LABELS[panel]} is a per-{t('pot', { lower: true })} view — pick a {t('pot')} from the dropdown above.
        </div>
        <style>{PANEL_FILL_CSS}</style>
      </section>
    );
  }

  // Git is its own dockview dock (AdvGitWorkspace) — Git graph + Pull
  // requests as dock panels, mirroring the Harness tab. It owns its own
  // slug handling via ?slug=, so no activeSlug plumbing here.
  if (panel === 'git') {
    return <AdvGitWorkspace />;
  }

  // Decoupled tabs: render the panel component directly.
  const direct = DIRECT[panel];
  if (direct) {
    return (
      <section className="pc-adv-harness-panel" aria-label={`ADV ${ADV_HARNESS_PANEL_LABELS[panel]} workspace`}>
        {activeSlug ? direct(activeSlug) : <div className="pc-adv-harness-panel__empty">Select a {t('pot')}.</div>}
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
