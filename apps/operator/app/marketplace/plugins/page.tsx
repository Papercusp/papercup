'use client';

import { useEffect, useMemo, useState } from 'react';
import MarketplaceList from '../MarketplaceList';

interface CatalogEntry {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  plugins: string[];
  homepage?: string;
  kind?: 'plugin' | 'template';
  topology?: 'single' | 'multi';
  subprojects?: Array<{ suffix: string; kind: string; department_slug?: string }>;
}

interface InstalledHarness {
  slug: string;
  version: string | null;
  description: string | null;
}

interface InstalledPluginRecord {
  name: string;
  version?: string;
  description?: string;
  source: string;
  path: string;
  /** Manifest-declared marketplace-hidden flag. Plugins with hidden:true still
   *  load and run, but don't appear as marketplace cards. */
  hidden?: boolean;
}

export default function PluginsPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installedTemplates, setInstalledTemplates] = useState<InstalledHarness[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [catalogRes, installedRes, pluginsRes] = await Promise.all([
          fetch('/api/marketplace/catalog', { cache: 'no-store' }),
          fetch('/api/installed', { cache: 'no-store' }),
          fetch('/api/plugins/global', { cache: 'no-store' }),
        ]);
        const catalogJson = catalogRes.ok ? await catalogRes.json() : { catalog: [] };
        const installedJson = installedRes.ok ? await installedRes.json() : { harnesses: [] };
        const pluginsJson = pluginsRes.ok ? await pluginsRes.json() : { plugins: [] };
        if (cancelled) return;
        setCatalog(Array.isArray(catalogJson?.catalog) ? catalogJson.catalog : []);
        setInstalledTemplates(Array.isArray(installedJson?.harnesses) ? installedJson.harnesses : []);
        setInstalledPlugins(Array.isArray(pluginsJson?.plugins) ? pluginsJson.plugins : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

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
        />
      )}
    </div>
  );
}

