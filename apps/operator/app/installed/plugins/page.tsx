'use client';

import { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { toast } from 'sonner';
import RouteLink from '../../_components/RouteLink';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';

interface InstalledPluginRecord {
  name: string;
  version?: string;
  description?: string;
  source: string;
  path: string;
  hidden?: boolean;
}

interface UpdateRow {
  slug: string;
  name: string;
  installed: string;
  available: string;
  capChange: { added: string[]; removed: string[]; unchanged: string[] };
}

interface RuntimeStatusRow {
  plugin: string;
  runtime: 'wasm' | 'daemon';
  pid?: number;
  restartCount?: number;
  ok: boolean;
  loadedFor: string[];
}

export default function InstalledPluginsPage() {
  const t = useLexicon();
  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([]);
  const [enabledMap, setEnabledMap] = useState<Record<string, string[]>>({});
  const [updates, setUpdates] = useState<Record<string, UpdateRow>>({});
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

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
        const [pluginsRes, updatesRes, runtimeRes] = await Promise.all([
          fetch('/api/plugins/global', { cache: 'no-store' }),
          fetch('/api/plugins/updates', { cache: 'no-store' }),
          fetch('/api/plugins/host/runtime-status', { cache: 'no-store' }),
        ]);
        const pluginsJson = pluginsRes.ok ? await pluginsRes.json() : { plugins: [] };
        const updatesJson = updatesRes.ok ? await updatesRes.json() : { updates: [] };
        const runtimeJson = runtimeRes.ok ? await runtimeRes.json() : { rows: [] };
        if (cancelled) return;
        const list = Array.isArray(pluginsJson?.plugins) ? pluginsJson.plugins : [];
        setPlugins(list.filter((p: InstalledPluginRecord) => !p.hidden));
        const upd: Record<string, UpdateRow> = {};
        for (const u of updatesJson?.updates ?? []) upd[u.slug] = u;
        setUpdates(upd);
        setRuntimeStatus(Array.isArray(runtimeJson?.rows) ? runtimeJson.rows : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function update(slug: string) {
    const u = updates[slug];
    if (!u) return;
    if (u.capChange.added.length > 0) {
      const lines = u.capChange.added.map((c) => `  • ${c}`).join('\n');
      const ok = await askConfirm({
        title: `${slug}: v${u.installed} → v${u.available}`,
        description: `New capabilities this version requests:\n${lines}`,
        confirmLabel: 'Continue update',
      });
      if (!ok) return;
    }
    // Plugin install/update flows through the Cupboard now (kind=plugin) — the
    // legacy :3057 /api/marketplace/install-plugin route is retired
    // (revive-cupboard-distribution D-004). Direct the user to the Cupboard to
    // reinstall at the new version.
    toast.info(`Update ${slug} from the Cupboard`, {
      description: `Plugin install/update is now in the Cupboard (kind=plugin). Open the Cupboard and reinstall ${slug} to pick up v${u.available}.`,
      duration: 8000,
    });
  }

  async function uninstall(slug: string) {
    const ok = await askConfirm({
      title: `Remove ${slug}?`,
      description: `Plugin will be disabled in every ${t('pot', { lower: true })} it was enabled in.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
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

  const runtimeStatusColumns: ColumnDef<RuntimeStatusRow>[] = [
    {
      key: 'plugin', header: 'Plugin', width: 2,
      toCopyText: (r) => r.plugin,
      render: ({ row }) => <>{row.plugin}</>,
    },
    {
      key: 'runtime', header: 'Runtime', width: 1,
      toCopyText: (r) => r.runtime,
      render: ({ row }) => <code style={{ fontSize: 11 }}>{row.runtime}</code>,
    },
    {
      key: 'loadedFor', header: 'Loaded for', width: 2,
      toCopyText: (r) => r.loadedFor.join(', '),
      render: ({ row }) => row.loadedFor.length > 0 ? <>{row.loadedFor.join(', ')}</> : <em style={{ opacity: 0.5 }}>—</em>,
    },
    {
      key: 'pid', header: 'PID', width: 1, align: 'right',
      toCopyText: (r) => r.pid != null ? String(r.pid) : '',
      render: ({ row }) => row.pid != null ? <>{row.pid}</> : <em style={{ opacity: 0.5 }}>—</em>,
    },
    {
      key: 'restarts', header: 'Restarts', width: 1, align: 'right',
      toCopyText: (r) => r.restartCount != null ? String(r.restartCount) : '',
      render: ({ row }) => row.restartCount != null ? <>{row.restartCount}</> : <em style={{ opacity: 0.5 }}>—</em>,
    },
    {
      key: 'ok', header: 'OK', width: 1, align: 'center',
      toCopyText: (r) => r.ok ? 'OK' : 'FAIL',
      render: ({ row }) => (
        <span style={{ color: row.ok ? 'var(--good)' : 'var(--bad)' }}>
          {row.ok ? '●' : '○'}
        </span>
      ),
    },
  ];

  return (
    <div className="pc-shell pc-marketplace-shell">
      {confirmEl}
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Installed plugins</p>
          <h1>Plugins on this machine.</h1>
          <p>Plugins you've installed locally. Each card shows where it's enabled.</p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Installed plugins">
          <div><strong>{plugins.length}</strong><span>installed</span></div>
          {Object.keys(updates).length > 0 && (
            <div style={{ background: 'var(--accent, #22d3ee)', color: '#000' }}>
              <strong>{Object.keys(updates).length}</strong>
              <span>update{Object.keys(updates).length === 1 ? '' : 's'}</span>
            </div>
          )}
          {runtimeStatus.length > 0 && (
            <div style={{ background: 'var(--bg-3)' }}>
              <strong>{runtimeStatus.length}</strong>
              <span>non-JS runtime{runtimeStatus.length === 1 ? '' : 's'}</span>
            </div>
          )}
        </div>
      </section>
      {runtimeStatus.length > 0 && (
        <section className="pc-card" style={{ padding: 12, marginBottom: 12 }}>
          <p className="pc-eyebrow" style={{ marginBottom: 8 }}>Plugin runtime status</p>
          <div style={{ height: Math.min(360, 36 + runtimeStatus.length * 32 + 4) }}>
            <RichGrid<RuntimeStatusRow>
              columns={runtimeStatusColumns}
              rows={runtimeStatus}
              getRowId={(r) => `${r.plugin}::${r.runtime}`}
              rowMinHeight={32}
              headerHeight={32}
            />
          </div>
        </section>
      )}
      {loading ? (
        <div className="pc-card pc-marketplace-loading">Loading installed plugins…</div>
      ) : plugins.length === 0 ? (
        <div className="pc-card pc-marketplace-empty">
          <strong>No plugins installed yet.</strong>
          <span>Browse the <RouteLink href="/cupboard?kind=plugin">Cupboard plugin catalog</RouteLink> to install one.</span>
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
                    <RouteLink href="/cupboard?kind=plugin" className="pc-marketplace-card-title">{p.name}</RouteLink>
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
                  {updates[p.name] && (
                    <button
                      className="pc-button"
                      style={{ background: 'var(--accent, #22d3ee)', color: '#000' }}
                      onClick={() => update(p.name)}
                      disabled={busy === p.name}
                      title={`Update v${updates[p.name].installed} → v${updates[p.name].available}${updates[p.name].capChange.added.length ? ` (new caps: ${updates[p.name].capChange.added.join(', ')})` : ''}`}
                    >
                      {busy === p.name ? 'updating…' : `Update → v${updates[p.name].available}`}
                    </button>
                  )}
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
