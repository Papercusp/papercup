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

async function loadCatalog(): Promise<CatalogEntry[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/marketplace/catalog`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.catalog) ? d.catalog : [];
  } catch { return []; }
}

async function loadInstalled(): Promise<InstalledHarness[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/installed`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.harnesses) ? d.harnesses : [];
  } catch { return []; }
}

export default async function TemplatesPage() {
  const [catalog, installed] = await Promise.all([loadCatalog(), loadInstalled()]);
  return (
    <div className="pc-shell">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Templates</h1>
        <nav style={{ display: 'flex', gap: 4 }}>
          <Link href="/marketplace/templates" aria-current="page" style={tabActive}>Templates</Link>
          <Link href="/marketplace/plugins" style={tabIdle}>Plugins</Link>
        </nav>
      </div>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 24 }}>
        Self-contained harness configurations. Install one to spin up a fresh harness instance —
        a complete autonomous-agent setup ready to run.
      </p>
      <MarketplaceList
        kind="template"
        catalog={catalog}
        installedTemplates={installed}
        installedPlugins={[]}
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
