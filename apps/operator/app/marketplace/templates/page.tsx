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

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const [catalog, installed] = await Promise.all([loadCatalog(), loadInstalled()]);
  const templates = catalog.filter((entry) => (entry.kind ?? 'template') === 'template');
  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Templates</p>
          <h1>Launch from a harness blueprint.</h1>
          <p>
            Self-contained harness configurations for coding projects, autonomous organizations, research pipelines, and any mission shape the marketplace grows into.
          </p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Template status">
          <div><strong>{templates.length}</strong><span>published</span></div>
          <div><strong>{installed.length}</strong><span>installed locally</span></div>
          <div><strong>{templates.filter((entry) => entry.topology === 'multi').length}</strong><span>multi-harness</span></div>
        </div>
      </section>
      <Suspense fallback={<div className="pc-card pc-marketplace-loading">Loading templates…</div>}>
        <MarketplaceList
          kind="template"
          catalog={catalog}
          installedTemplates={installed}
          installedPlugins={[]}
        />
      </Suspense>
    </div>
  );
}

