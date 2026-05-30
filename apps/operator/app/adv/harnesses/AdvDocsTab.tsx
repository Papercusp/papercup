'use client';

// adv:docs — renders the harness's docs plugin tab directly (the
// @papercupai/starlight plugin embeds the per-harness Starlight docs as an
// iframe; it `replaces: ['docs']`). Resolves the plugin contribution from
// /api/plugins/<slug>/contributions and renders the iframe — no
// HarnessDashboard. docs is entirely plugin-provided, so when no plugin
// contributes a docs tab the panel shows an explicit empty state.

import { useEffect, useMemo, useState } from 'react';

interface DashTab {
  tabId: string;
  label: string;
  iframeUrl: string | null;
  componentRoot: string | null;
  componentId: string | null;
  replaces: string[];
}

function useDocsTab(slug: string): { tab: DashTab | null; loading: boolean } {
  const [tabs, setTabs] = useState<DashTab[] | null>(null);
  useEffect(() => {
    if (!slug) {
      setTabs([]);
      return;
    }
    let cancel = false;
    setTabs(null);
    fetch(`/api/plugins/${encodeURIComponent(slug)}/contributions`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { dashboardTabs: [] }))
      .then((j: { dashboardTabs?: Array<Record<string, unknown>> }) => {
        if (cancel) return;
        setTabs(
          (j.dashboardTabs ?? []).map((t) => ({
            tabId: String(t.id ?? ''),
            label: String(t.label ?? 'Docs'),
            iframeUrl: typeof t.iframeUrl === 'string' ? t.iframeUrl : null,
            componentRoot: typeof t.componentRoot === 'string' ? t.componentRoot : null,
            componentId: typeof t.componentId === 'string' ? t.componentId : null,
            replaces: Array.isArray(t.replaces) ? (t.replaces as string[]) : [],
          })),
        );
      })
      .catch(() => {
        if (!cancel) setTabs([]);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  // The docs tab is whichever contribution replaces the legacy `docs` tab.
  const tab = useMemo(() => (tabs ?? []).find((t) => t.replaces.includes('docs')) ?? null, [tabs]);
  return { tab, loading: tabs === null };
}

export default function AdvDocsTab({ slug }: { slug: string }) {
  const { tab, loading } = useDocsTab(slug);

  if (loading) return <div className="pc-adv-harness-panel__empty">Loading docs…</div>;
  if (!tab) {
    return (
      <div className="pc-adv-harness-panel__empty">
        No docs plugin enabled for this harness. Enable <code>@papercupai/starlight</code> to embed the docs site.
      </div>
    );
  }
  if (tab.iframeUrl) {
    return (
      <iframe
        src={tab.iframeUrl}
        title={tab.label}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
    );
  }
  // React-component plugin tabs (componentRoot/componentId) aren't wired into
  // /adv yet — iframe is the common case (starlight/fumadocs). The legacy
  // dashboard's PluginReactTab loader can be lifted here if a docs plugin
  // ships a React tab.
  return (
    <div className="pc-adv-harness-panel__empty">
      This docs plugin uses a React-component tab, which isn’t supported in /adv yet.
    </div>
  );
}
