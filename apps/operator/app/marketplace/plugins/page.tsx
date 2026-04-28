import Link from 'next/link';
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

export default async function PluginsPage() {
  const [catalog, installedTemplates, installedPlugins] = await Promise.all([
    loadCatalog(),
    loadInstalledHarnesses(),
    loadInstalledPlugins(),
  ]);
  return (
    <div className="pc-shell">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Plugins</h1>
        <nav style={{ display: 'flex', gap: 4 }}>
          <Link href="/marketplace/templates" style={tabIdle}>Templates</Link>
          <Link href="/marketplace/plugins" aria-current="page" style={tabActive}>Plugins</Link>
        </nav>
      </div>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 24 }}>
        Extend an existing harness with new actions, dashboard tabs, secrets, or integrations.
        Install per-machine, then enable per-harness.
      </p>
      <MarketplaceList
        kind="plugin"
        catalog={catalog}
        installedTemplates={installedTemplates}
        installedPlugins={installedPlugins}
      />
    </div>
  );
}

const tabBase: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 500, textDecoration: 'none',
};
const tabActive: React.CSSProperties = {
  ...tabBase, background: 'var(--bg-1)', color: 'var(--fg)', border: '1px solid var(--border)',
};
const tabIdle: React.CSSProperties = {
  ...tabBase, color: 'var(--fg-mute)',
};
