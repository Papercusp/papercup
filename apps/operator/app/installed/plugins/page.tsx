'use client';

import { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { toast } from 'sonner';
import RouteLink from '../../_components/RouteLink';
import { useSyncQuery } from '@restart/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

interface InstalledPluginRecord {
  name: string;
  version?: string;
  description?: string;
  source: string;
  path: string;
  hidden?: boolean;
}

export default function InstalledPluginsPage() {
  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([]);
  const [enabledMap, setEnabledMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  // pluginEnables is in Zero already (pluginEnables.byWorkspace). The
  // /plugins/global side is still REST — it's a cross-workspace listing
  // of installed plugins, not workspace-keyed. Two-phase load: render
  // the enabled-map from the cached subscription synchronously, then
  // pull plugin metadata from REST (typically <100ms cold).
  const pluginsWorkspaceId = useWorkspaceId();
  const { data: pluginEnableRows } = useSyncQuery<{
    harnessSlug: string;
    pluginSlug: string;
    enabled: boolean;
  }>({
    queryName: 'pluginEnables.byWorkspace',
    args: { workspaceId: pluginsWorkspaceId },
    enabled: !!pluginsWorkspaceId,
  });
  useEffect(() => {
    if (!Array.isArray(pluginEnableRows)) return;
    const m: Record<string, string[]> = {};
    for (const r of pluginEnableRows) {
      if (!r.enabled) continue;
      (m[r.harnessSlug] ??= []).push(r.pluginSlug);
    }
    setEnabledMap(m);
  }, [pluginEnableRows]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const pluginsRes = await fetch('/api/plugins/global', { cache: 'no-store' });
        const pluginsJson = pluginsRes.ok ? await pluginsRes.json() : { plugins: [] };
        if (cancelled) return;
        const list = Array.isArray(pluginsJson?.plugins) ? pluginsJson.plugins : [];
        setPlugins(list.filter((p: InstalledPluginRecord) => !p.hidden));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function uninstall(slug: string) {
    if (!confirm(`Remove ${slug}? Plugin will be disabled in every harness it was enabled in.`)) return;
    setBusy(slug);
    try {
      const r = await fetch('/api/plugins/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d.error ?? 'uninstall failed');
        return;
      }
      toast.success(`${slug} removed`);
      setTimeout(() => setReloadKey((k) => k + 1), 400);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Installed plugins</p>
          <h1>Plugins on this machine.</h1>
          <p>Plugins you've installed locally. Each card shows where it's enabled.</p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Installed plugins">
          <div><strong>{plugins.length}</strong><span>installed</span></div>
        </div>
      </section>
      {loading ? (
        <div className="pc-card pc-marketplace-loading">Loading installed plugins…</div>
      ) : plugins.length === 0 ? (
        <div className="pc-card pc-marketplace-empty">
          <strong>No plugins installed yet.</strong>
          <span>Browse the <RouteLink href="/marketplace/plugins">plugin catalog</RouteLink> to install one.</span>
        </div>
      ) : (
        <div className="pc-marketplace-grid pc-installed-plugin-grid">
          {plugins.map((p) => {
            const enabledHere = Object.entries(enabledMap).filter(([, slugs]) => slugs.includes(p.name)).map(([h]) => h);
            return (
              <article key={p.name} className="pc-card pc-marketplace-card installed pc-installed-plugin-card">
                <div className="pc-marketplace-card-head">
                  <span className="pc-marketplace-card-icon plugin"><Lucide.Puzzle size={18} /></span>
                  <div>
                    <RouteLink href={`/marketplace/${encodeURIComponent(p.name)}`} className="pc-marketplace-card-title">{p.name}</RouteLink>
                    <span>{p.source}</span>
                  </div>
                  <em>Installed</em>
                </div>
                <p>{p.description ?? `Installed from ${p.source}.`}</p>
                <div className="pc-marketplace-meta">
                  <span>v{p.version ?? 'local'}</span>
                  <span>{p.path}</span>
                </div>
                {enabledHere.length > 0 && (
                  <div className="pc-marketplace-enabled pc-installed-plugin-enabled">
                    <strong>Enabled in</strong>
                    {enabledHere.map((h) => <code key={h}>{h}</code>)}
                  </div>
                )}
                <div className="pc-marketplace-card-actions pc-installed-plugin-actions">
                  <RouteLink
                    href={`/installed/plugins/${encodeURIComponent(p.name)}/permissions`}
                    className="pc-button"
                  >
                    Permissions
                  </RouteLink>
                  <button
                    className="pc-button danger pc-installed-plugin-uninstall"
                    onClick={() => uninstall(p.name)}
                    disabled={busy === p.name}
                  >
                    {busy === p.name ? 'removing…' : 'Uninstall'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
