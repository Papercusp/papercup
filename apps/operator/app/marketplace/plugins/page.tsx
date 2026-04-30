import { Suspense } from 'react';
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
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/marketplace/catalog`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.catalog) ? d.catalog : [];
  } catch { return []; }
}

async function loadInstalledHarnesses(): Promise<InstalledHarness[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/installed`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.harnesses) ? d.harnesses : [];
  } catch { return []; }
}

async function loadInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/plugins/global`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.plugins) ? d.plugins : [];
  } catch { return []; }
}

export const dynamic = 'force-dynamic';

export default async function PluginsPage() {
  const [catalog, installedTemplates, installedPlugins] = await Promise.all([
    loadCatalog(),
    loadInstalledHarnesses(),
    loadInstalledPlugins(),
  ]);
  const plugins = catalog.filter((entry) => entry.kind === 'plugin');
  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Plugins</p>
          <h1>Install capabilities without surrendering control.</h1>
          <p>
            Extend installed harnesses with new actions, dashboard tabs, API routes, routines, lifecycle hooks, roles, and integrations — all permissioned through the Papercusp capability model.
          </p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Plugin status">
          <div><strong>{plugins.length}</strong><span>published</span></div>
          <div><strong>{installedPlugins.length}</strong><span>installed locally</span></div>
          <div><strong>{installedTemplates.length}</strong><span>available harnesses</span></div>
        </div>
      </section>
      <Suspense fallback={<div className="pc-card pc-marketplace-loading">Loading plugins…</div>}>
        <MarketplaceList
          kind="plugin"
          catalog={catalog}
          installedTemplates={installedTemplates}
          installedPlugins={installedPlugins}
        />
      </Suspense>
    </div>
  );
}

