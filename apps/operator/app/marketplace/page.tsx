import Link from 'next/link';

interface CatalogEntry {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  plugins: string[];
  kind?: 'plugin' | 'template';
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

interface SnapshotRow {
  id: string;
  harnessSlug: string;
}

export const dynamic = 'force-dynamic';

async function loadCatalog(): Promise<CatalogEntry[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/marketplace/catalog`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.catalog) ? d.catalog : [];
  } catch {
    return [];
  }
}

async function loadInstalledHarnesses(): Promise<InstalledHarness[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/installed`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.harnesses) ? d.harnesses : [];
  } catch {
    return [];
  }
}

async function loadInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/plugins/global`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.plugins) ? d.plugins : [];
  } catch {
    return [];
  }
}

async function loadSnapshots(): Promise<SnapshotRow[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/snapshots`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.snapshots) ? d.snapshots : [];
  } catch {
    return [];
  }
}

export default async function MarketplaceIndex() {
  const [catalog, harnesses, plugins, snapshots] = await Promise.all([
    loadCatalog(),
    loadInstalledHarnesses(),
    loadInstalledPlugins(),
    loadSnapshots(),
  ]);
  const templates = catalog.filter((entry) => (entry.kind ?? 'template') === 'template');
  const pluginCatalog = catalog.filter((entry) => entry.kind === 'plugin');

  const cards = [
    {
      label: 'Templates',
      href: '/marketplace/templates',
      count: templates.length,
      installed: harnesses.length,
      title: 'Start a new harness from a proven recipe.',
      body: 'Coding projects, autonomous orgs, research flows, and any future mission template live here.',
      cta: 'Browse templates',
    },
    {
      label: 'Plugins',
      href: '/marketplace/plugins',
      count: pluginCatalog.length,
      installed: plugins.length,
      title: 'Extend active harnesses with permissioned capabilities.',
      body: 'Add dashboard tabs, actions, hooks, routes, routines, roles, and integrations through the plugin runtime.',
      cta: 'Browse plugins',
    },
    {
      label: 'Snapshots',
      href: '/marketplace/snapshots',
      count: snapshots.length,
      installed: snapshots.length,
      title: 'Fork, publish, and restore frozen harness state.',
      body: 'Snapshots package project files, database state, plugins, and redaction metadata into reusable artifacts.',
      cta: 'Manage snapshots',
    },
  ];

  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-hero" aria-labelledby="marketplace-title">
        <div>
          <p className="pc-eyebrow">Marketplace</p>
          <h1 id="marketplace-title">Install the next shape of your autonomous work.</h1>
          <p>
            Discover templates, plugins, and snapshots that compose with the Papercusp substrate: fresh-context roles, structured state, capability gates, and local-first operation.
          </p>
          <div className="pc-marketplace-actions">
            <Link href="/marketplace/templates" className="pc-button primary">Browse templates</Link>
            <Link href="/marketplace/plugins" className="pc-button">Explore plugins</Link>
            <Link href="/marketplace/snapshots" className="pc-button ghost">Manage snapshots</Link>
          </div>
        </div>
        <aside className="pc-marketplace-command" aria-label="Install command preview">
          <div className="pc-marketplace-command-top">
            <span><i /> Local catalog</span>
            <strong>Ready</strong>
          </div>
          <div className="pc-marketplace-terminal">
            <code><span>$</span> papercusp install papercup-coding</code>
            <code><span>✓</span> capabilities reviewed</code>
            <code><span>✓</span> template mounted locally</code>
            <code><span>→</span> open mission control</code>
          </div>
        </aside>
      </section>

      <section className="pc-marketplace-stat-row" aria-label="Marketplace summary">
        <div><strong>{templates.length}</strong><span>published templates</span></div>
        <div><strong>{pluginCatalog.length}</strong><span>published plugins</span></div>
        <div><strong>{harnesses.length}</strong><span>installed harnesses</span></div>
        <div><strong>{snapshots.length}</strong><span>local snapshots</span></div>
      </section>

      <section className="pc-marketplace-collections" aria-label="Marketplace collections">
        {cards.map((card) => (
          <Link key={card.label} href={card.href} className="pc-marketplace-collection pc-card">
            <span>{card.label}</span>
            <h2>{card.title}</h2>
            <p>{card.body}</p>
            <div>
              <strong>{card.count}</strong>
              <em>{card.label === 'Snapshots' ? 'local' : 'published'}</em>
              <strong>{card.installed}</strong>
              <em>{card.label === 'Plugins' ? 'installed' : card.label === 'Templates' ? 'installed' : 'available'}</em>
            </div>
            <b>{card.cta} →</b>
          </Link>
        ))}
      </section>

      <section className="pc-marketplace-policy">
        <div>
          <p className="pc-eyebrow">Trust model</p>
          <h2>Useful packages, explicit blast radius.</h2>
          <p>
            Marketplace artifacts are designed for a self-hosted substrate: templates scaffold state, plugins declare capabilities, and snapshots preserve enough provenance to fork safely.
          </p>
        </div>
        <ol>
          <li><strong>Pick an artifact</strong><span>Choose a template, plugin, or snapshot.</span></li>
          <li><strong>Review scope</strong><span>Capabilities and install shape are visible before activation.</span></li>
          <li><strong>Run locally</strong><span>Your files, keys, and project state stay on this machine.</span></li>
        </ol>
      </section>
    </div>
  );
}
