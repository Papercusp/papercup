'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  MarketplaceList,
  type CatalogEntry,
  type InstalledHarness,
  type InstalledPluginRecord,
} from '@papercup/marketplace-public-ui';

export default function MarketplacePluginsClient() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installedTemplates, setInstalledTemplates] = useState<InstalledHarness[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginRecord[]>([]);
  const [enabledMap, setEnabledMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [catalogRes, installedRes, pluginsRes, enabledRes] = await Promise.all([
          fetch('/api/marketplace/catalog', { cache: 'no-store' }),
          fetch('/api/installed', { cache: 'no-store' }),
          fetch('/api/plugins/global', { cache: 'no-store' }),
          fetch('/api/plugins/enabled', { cache: 'no-store' }),
        ]);
        const catalogJson = catalogRes.ok ? await catalogRes.json() : { catalog: [] };
        const installedJson = installedRes.ok ? await installedRes.json() : { harnesses: [] };
        const pluginsJson = pluginsRes.ok ? await pluginsRes.json() : { plugins: [] };
        const enabledJson = enabledRes.ok ? await enabledRes.json() : { enabled: {} };
        if (cancelled) return;
        setCatalog(Array.isArray(catalogJson?.catalog) ? catalogJson.catalog : []);
        setInstalledTemplates(Array.isArray(installedJson?.harnesses) ? installedJson.harnesses : []);
        setInstalledPlugins(Array.isArray(pluginsJson?.plugins) ? pluginsJson.plugins : []);
        setEnabledMap(enabledJson?.enabled ?? {});
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const plugins = useMemo(
    () => catalog.filter((entry) => entry.kind === 'plugin'),
    [catalog],
  );

  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Plugins</p>
          <h1>Add abilities to a workflow.</h1>
          <p>
            Plugins extend an installed workflow with new actions — publishing, integrations, dashboards, hooks. Each one declares exactly what it can access before you install it.
          </p>
          <p style={{ marginTop: 8, fontSize: 13 }}>
            <a href="/docs/spec/plugin-quickstart" className="pc-link">
              Build your own →
            </a>
          </p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Plugin status">
          <div><strong>{plugins.length}</strong><span>available</span></div>
          {installedPlugins.length > 0 && <div><strong>{installedPlugins.length}</strong><span>installed</span></div>}
        </div>
      </section>
      {loading ? (
        <div className="pc-card pc-marketplace-loading">Loading plugins…</div>
      ) : (
        <MarketplaceList
          kind="plugin"
          catalog={catalog}
          installedTemplates={installedTemplates}
          installedPlugins={installedPlugins}
          enabledMap={enabledMap}
          onInstallPlugin={async (slug) => {
            const r = await fetch('/api/marketplace/install-plugin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug }),
            });
            return r.json();
          }}
          onUninstall={async (slug) => {
            const r = await fetch('/api/plugins/uninstall', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug }),
            });
            return r.json();
          }}
          onEnable={async (slug, harnesses, disable) => {
            const r = await fetch('/api/plugins/enable', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug, harnesses, disable: !!disable }),
            });
            return r.json();
          }}
          onAfterChange={() => setTimeout(() => setReloadKey((k) => k + 1), 600)}
          notify={(level, msg, detail) => {
            if (level === 'error') toast.error(msg, detail ? { description: detail } : undefined);
            else toast.success(msg, detail ? { description: detail } : undefined);
          }}
        />
      )}
    </div>
  );
}
