'use client';

// adv:config — renders the extracted <ConfigPanel/> directly (harness spec
// editor + per-plugin config panes), supplying the props the legacy
// HarnessDashboard used to compute inline: project path/alive (from /status),
// the installed-plugin list (/api/plugins/global), the enabled-plugin slugs
// (Zero pluginEnables.byWorkspace), and the "needs setup" map (Zero
// pluginConfigs.byHarness intersected with each plugin's configSchema.required).
// This is what lets /adv mount config WITHOUT the whole dashboard.

import { useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { ConfigPanel } from '@/app/harness/ConfigPanel';
import { pluginSlugFromPath, type InstalledPluginInfo } from '@/app/harness/plugin-utils';

interface StatusLite {
  project?: { path?: string };
  alive?: boolean;
}

export default function AdvConfigTab({ slug }: { slug: string }) {
  const [status, setStatus] = useState<StatusLite | null>(null);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginInfo[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [configPane, setConfigPane] = useQueryState('configPane', parseAsString.withDefault('harness'));
  const ws = useWorkspaceId();

  // project path + alive (the spec editor wants both).
  useEffect(() => {
    let cancel = false;
    setStatus(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=staging`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancel) setStatus(j ?? {});
      })
      .catch(() => {
        if (!cancel) setStatus({});
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  // Installed plugins (re-fetched when ConfigPanel signals enable/disable).
  useEffect(() => {
    const ac = new AbortController();
    fetch('/api/plugins/global', { cache: 'no-store', signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setInstalledPlugins(Array.isArray(d?.plugins) ? d.plugins : []))
      .catch(() => {
        /* leave null → ConfigPanel shows just the Harness pane */
      });
    return () => ac.abort();
  }, [refreshKey]);

  // Enabled-plugin slugs for this harness (Zero, live).
  const { data: pluginEnableRows } = useSyncQuery<{ harnessSlug: string; pluginSlug: string; enabled: boolean }>({
    queryName: 'pluginEnables.byWorkspace',
    args: { workspaceId: ws },
    enabled: !!ws,
  });
  const enabledSlugs = useMemo(() => {
    if (!Array.isArray(pluginEnableRows)) return [];
    return pluginEnableRows.filter((r) => r.enabled && r.harnessSlug === slug).map((r) => r.pluginSlug);
  }, [pluginEnableRows, slug]);

  // Missing required config per plugin → the "needs setup" dots on tabs.
  const { data: pluginConfigRows } = useSyncQuery<{ harnessSlug: string; pluginSlug: string; config: Record<string, unknown> | null }>({
    queryName: 'pluginConfigs.byHarness',
    args: { harnessSlug: slug, workspaceId: ws },
    enabled: !!slug && !!ws,
  });
  const pluginsMissing = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    if (!installedPlugins || enabledSlugs.length === 0) return out;
    const cfgByDir = new Map<string, Record<string, unknown>>();
    if (Array.isArray(pluginConfigRows)) {
      for (const r of pluginConfigRows) cfgByDir.set(r.pluginSlug, (r.config ?? {}) as Record<string, unknown>);
    }
    for (const s of enabledSlugs) {
      const m = installedPlugins.find(
        (p) => p.name === s || (p.path ? pluginSlugFromPath(p.path, p.name) : null) === s,
      );
      if (!m) continue;
      const required = (m as { configSchema?: { required?: string[] } }).configSchema?.required ?? [];
      if (required.length === 0) continue;
      const dirSlug = m.path ? pluginSlugFromPath(m.path, m.name) : m.name;
      const cfg = cfgByDir.get(dirSlug) ?? {};
      const missing = required.filter((f) => {
        const v = cfg[f];
        return v === undefined || v === null || (typeof v === 'string' && v.length === 0);
      });
      if (missing.length) out[m.name] = missing;
    }
    return out;
  }, [installedPlugins, enabledSlugs, pluginConfigRows]);

  if (!status) return <div className="pc-adv-harness-panel__empty">Loading config…</div>;

  return (
    <ConfigPanel
      harnessSlug={slug}
      projectPath={status.project?.path ?? ''}
      alive={!!status.alive}
      onClose={() => {}}
      installedPlugins={installedPlugins ?? []}
      enabledSlugs={enabledSlugs}
      pluginCount={enabledSlugs.length}
      onPluginsChange={() => setRefreshKey((k) => k + 1)}
      activePane={configPane}
      onPaneChange={(p) => void setConfigPane(p)}
      pluginsMissing={pluginsMissing}
    />
  );
}
