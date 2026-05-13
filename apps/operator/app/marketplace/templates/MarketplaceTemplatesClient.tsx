'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  MarketplaceList,
  type CatalogEntry,
  type InstalledHarness,
} from '@papercup/marketplace-public-ui';

export default function MarketplaceTemplatesClient() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledHarness[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [catalogRes, installedRes] = await Promise.all([
          fetch('/api/marketplace/catalog', { cache: 'no-store' }),
          fetch('/api/installed', { cache: 'no-store' }),
        ]);
        const catalogJson = catalogRes.ok ? await catalogRes.json() : { catalog: [] };
        const installedJson = installedRes.ok ? await installedRes.json() : { harnesses: [] };
        if (cancelled) return;
        setCatalog(Array.isArray(catalogJson?.catalog) ? catalogJson.catalog : []);
        setInstalled(Array.isArray(installedJson?.harnesses) ? installedJson.harnesses : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const templates = useMemo(
    () => catalog.filter((entry) => (entry.kind ?? 'template') === 'template'),
    [catalog],
  );

  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Templates</p>
          <h1>Pick a workflow to install.</h1>
          <p>
            Each template is a complete AI workflow — coding, research, ops, content, anything someone has packaged. Install one, give it a goal, watch it work.
          </p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Template status">
          <div><strong>{templates.length}</strong><span>available</span></div>
          {installed.length > 0 && <div><strong>{installed.length}</strong><span>local projects</span></div>}
        </div>
      </section>
      {loading ? (
        <div className="pc-card pc-marketplace-loading">Loading templates…</div>
      ) : (
        <MarketplaceList
          kind="template"
          catalog={catalog}
          installedTemplates={installed}
          onInstallTemplate={async (slug, opts) => {
            const r = await fetch('/api/marketplace/install', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug, ...opts }),
            });
            return r.json();
          }}
          onUninstall={async (slug) => {
            const r = await fetch('/api/marketplace/uninstall', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug }),
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
