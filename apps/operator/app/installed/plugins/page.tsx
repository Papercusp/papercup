'use client';

import { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { toast } from 'sonner';

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [pluginsRes, enabledRes] = await Promise.all([
          fetch('/api/plugins/global', { cache: 'no-store' }),
          fetch('/api/plugins/enabled', { cache: 'no-store' }),
        ]);
        const pluginsJson = pluginsRes.ok ? await pluginsRes.json() : { plugins: [] };
        const enabledJson = enabledRes.ok ? await enabledRes.json() : { enabled: {} };
        if (cancelled) return;
        const list = Array.isArray(pluginsJson?.plugins) ? pluginsJson.plugins : [];
        setPlugins(list.filter((p: InstalledPluginRecord) => !p.hidden));
        setEnabledMap(enabledJson?.enabled ?? {});
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
          <span>Browse the <a href="/marketplace/plugins">plugin catalog</a> to install one.</span>
        </div>
      ) : (
        <div className="pc-marketplace-grid">
          {plugins.map((p) => {
            const enabledHere = Object.entries(enabledMap).filter(([, slugs]) => slugs.includes(p.name)).map(([h]) => h);
            return (
              <article key={p.name} className="pc-card pc-marketplace-card installed">
                <div className="pc-marketplace-card-head">
                  <span className="pc-marketplace-card-icon plugin"><Lucide.Puzzle size={18} /></span>
                  <div>
                    <a href={`/marketplace/${encodeURIComponent(p.name)}`} className="pc-marketplace-card-title">{p.name}</a>
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
                  <div className="pc-marketplace-enabled">
                    <strong>Enabled in</strong>
                    {enabledHere.map((h) => <code key={h}>{h}</code>)}
                  </div>
                )}
                <div className="pc-marketplace-card-actions">
                  <button
                    className="pc-button danger"
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
