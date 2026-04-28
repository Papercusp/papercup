'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as Lucide from 'lucide-react';
import InstallButton from './InstallButton';

interface CatalogEntry {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  plugins: string[];
  homepage?: string | null;
  kind?: 'plugin' | 'template';
  icon?: string | null;
  topology?: 'single' | 'multi';
  subprojects?: Array<{ suffix: string; kind: string; department_slug?: string }>;
}

function CardIcon({ name, kind }: { name: string | null | undefined; kind: 'plugin' | 'template' }) {
  const fallback = kind === 'plugin' ? Lucide.Puzzle : Lucide.Package;
  const Icon = (name && (Lucide as Record<string, unknown>)[name] as React.ComponentType<{ size?: number }>) ?? fallback;
  const tint = kind === 'plugin'
    ? { bg: 'rgba(99, 102, 241, 0.15)', fg: '#a5b4fc', border: 'rgba(99, 102, 241, 0.3)' }
    : { bg: 'rgba(34, 197, 94, 0.12)', fg: '#86efac', border: 'rgba(34, 197, 94, 0.3)' };
  return (
    <span style={{
      flex: '0 0 auto', width: 32, height: 32, borderRadius: 6,
      background: tint.bg, color: tint.fg, border: `1px solid ${tint.border}`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Icon size={16} />
    </span>
  );
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

interface Props {
  kind: 'plugin' | 'template';
  catalog: CatalogEntry[];
  installedTemplates: InstalledHarness[];
  installedPlugins: InstalledPluginRecord[];
}

export default function MarketplaceList({ kind, catalog, installedTemplates, installedPlugins }: Props) {
  const isPlugin = kind === 'plugin';
  const filtered = useMemo(() => catalog.filter((c) => (c.kind ?? 'template') === kind), [catalog, kind]);
  const [q, setQ] = useState('');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [enablePicker, setEnablePicker] = useState<string | null>(null);
  const [enabledMap, setEnabledMap] = useState<Record<string, string[]>>({});

  const installedSlugs = useMemo(() => {
    return new Set(isPlugin ? installedPlugins.map((p) => p.name) : installedTemplates.map((h) => h.slug));
  }, [isPlugin, installedPlugins, installedTemplates]);

  const harnesses = installedTemplates;

  useEffect(() => {
    if (!isPlugin) return;
    fetch('/api/plugins/enabled', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setEnabledMap(d?.enabled ?? {}))
      .catch(() => {});
  }, [isPlugin, busySlug]);

  const visibleCatalog = useMemo(() => {
    if (!q.trim()) return filtered;
    const needle = q.toLowerCase();
    return filtered.filter((p) =>
      [p.name, p.description, p.author].some((v) => v?.toLowerCase().includes(needle)),
    );
  }, [filtered, q]);

  async function uninstall(slug: string) {
    if (!confirm(`Remove ${slug}?\n\n${isPlugin ? 'Plugin will be disabled in every harness it was enabled in.' : 'Projects you initialised from this template will be untouched.'}`)) return;
    setBusySlug(slug);
    try {
      const url = isPlugin ? '/api/plugins/uninstall' : '/api/marketplace/uninstall';
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d.error ?? 'uninstall failed', { description: d.log?.slice(-400) });
        return;
      }
      toast.success(`${slug} removed`, { description: d.log?.slice(-400) });
      setTimeout(() => window.location.reload(), 600);
    } catch (e: any) {
      toast.error(`uninstall failed: ${e?.message ?? e}`);
    } finally {
      setBusySlug(null);
    }
  }

  async function enableIn(slug: string, harnessSlugs: string[]) {
    if (harnessSlugs.length === 0) return;
    setBusySlug(slug);
    try {
      const r = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, harnesses: harnessSlugs }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d.error ?? 'enable failed', { description: d.results?.find((x: any) => !x.ok)?.log?.slice(-400) });
        return;
      }
      toast.success(`${slug} enabled in ${harnessSlugs.length} harness${harnessSlugs.length === 1 ? '' : 'es'}`);
      setEnablePicker(null);
    } catch (e: any) {
      toast.error(`enable failed: ${e?.message ?? e}`);
    } finally {
      setBusySlug(null);
    }
  }

  async function disableIn(slug: string, harnessSlugs: string[]) {
    if (harnessSlugs.length === 0) return;
    setBusySlug(slug);
    try {
      const r = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, harnesses: harnessSlugs, disable: true }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d.error ?? 'disable failed', { description: d.results?.find((x: any) => !x.ok)?.log?.slice(-400) });
        return;
      }
      toast.success(`${slug} disabled in ${harnessSlugs.length} harness${harnessSlugs.length === 1 ? '' : 'es'}`);
    } catch (e: any) {
      toast.error(`disable failed: ${e?.message ?? e}`);
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <>
      <input
        type="search"
        placeholder={`Search ${isPlugin ? 'plugins' : 'templates'} by name, description, or author…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{
          width: '100%', padding: '10px 14px', marginBottom: 20,
          background: 'var(--bg-1)', color: 'var(--fg)',
          border: '1px solid var(--border)', borderRadius: 6, fontSize: 14,
        }}
      />

      <div className="pc-grid cards-3">
        {visibleCatalog.map((p) => {
          const installed = installedSlugs.has(p.slug);
          const enabledHere: string[] = isPlugin
            ? Object.entries(enabledMap).filter(([, slugs]) => slugs.includes(p.slug)).map(([h]) => h)
            : [];
          return (
            <div key={p.slug} className="pc-card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                <CardIcon name={p.icon} kind={kind} />
                <h3 style={{ marginTop: 0, marginBottom: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</h3>
                {installed && (
                  <span style={{ fontSize: 10, color: 'var(--good)', textTransform: 'uppercase', letterSpacing: 0.04 }}>installed</span>
                )}
              </div>
              <p style={{ minHeight: 56, fontSize: 13 }}>{p.description}</p>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--fg-mute)', marginBottom: 12, flexWrap: 'wrap' }}>
                <span>v{p.version}</span>
                <span>·</span>
                <span>{p.license}</span>
                {p.author && <><span>·</span><span>{p.author}</span></>}
                {!isPlugin && p.topology === 'multi' && p.subprojects && p.subprojects.length > 0 && (
                  <><span>·</span><span style={{ color: 'var(--accent)' }}>multi-topology · {p.subprojects.length} sub-harnesses</span></>
                )}
              </div>

              {isPlugin && installed && enabledHere.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 8 }}>
                  enabled in: {enabledHere.map((h, i) => (
                    <span key={h}>
                      <code style={{ fontSize: 11, padding: '0 4px', background: 'var(--bg-1)', borderRadius: 3 }}>{h}</code>
                      {i < enabledHere.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 'auto', display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {!installed && (
                  isPlugin
                    ? <InstallPluginButton slug={p.slug} />
                    : <InstallButton slug={p.slug} alreadyInstalled={false} topology={p.topology} subprojects={p.subprojects} />
                )}
                {installed && isPlugin && (
                  <button
                    className="pc-button"
                    onClick={() => setEnablePicker(p.slug)}
                    disabled={busySlug === p.slug || harnesses.length === 0}
                    title={harnesses.length === 0 ? 'No harnesses installed' : 'Enable / disable in specific harnesses'}
                    style={{ background: 'var(--bg-1)' }}
                  >
                    Enable in harness…
                  </button>
                )}
                {installed && (
                  <button
                    className="pc-button"
                    onClick={() => uninstall(p.slug)}
                    disabled={busySlug === p.slug}
                    style={{ background: 'transparent', color: 'var(--bad)', border: '1px solid var(--border)' }}
                  >
                    {busySlug === p.slug ? 'removing…' : 'Uninstall'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {visibleCatalog.length === 0 && (
          <div className="pc-card pc-skeleton" style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 32 }}>
            {q.trim() ? `No ${isPlugin ? 'plugins' : 'templates'} match "${q}"` : `No ${isPlugin ? 'plugins' : 'templates'} published yet.`}
          </div>
        )}
      </div>

      {enablePicker && (
        <EnablePicker
          slug={enablePicker}
          harnesses={harnesses}
          enabledIn={Object.entries(enabledMap).filter(([, slugs]) => slugs.includes(enablePicker)).map(([h]) => h)}
          onCancel={() => setEnablePicker(null)}
          onApply={async (toEnable, toDisable) => {
            if (toDisable.length > 0) await disableIn(enablePicker, toDisable);
            if (toEnable.length > 0) await enableIn(enablePicker, toEnable);
            setEnablePicker(null);
          }}
        />
      )}
    </>
  );
}

function InstallPluginButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await fetch('/api/marketplace/install-plugin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d.error ?? 'install failed', { description: d.log?.slice(-400) });
        return;
      }
      toast.success(`${slug} installed`);
      setTimeout(() => window.location.reload(), 600);
    } catch (e: any) {
      toast.error(`install failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  }
  return (
    <button className="pc-button" onClick={go} disabled={busy}>
      {busy ? 'Installing…' : 'Install'}
    </button>
  );
}

interface EnablePickerProps {
  slug: string;
  harnesses: InstalledHarness[];
  enabledIn: string[];
  onCancel: () => void;
  onApply: (toEnable: string[], toDisable: string[]) => Promise<void>;
}
function EnablePicker({ slug, harnesses, enabledIn, onCancel, onApply }: EnablePickerProps) {
  const initial = useMemo(() => new Set(enabledIn), [enabledIn]);
  const [selected, setSelected] = useState<Set<string>>(initial);
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => {
    if (selected.size !== initial.size) return true;
    for (const s of selected) if (!initial.has(s)) return true;
    return false;
  }, [selected, initial]);

  function toggle(h: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(h)) next.delete(h); else next.add(h);
      return next;
    });
  }

  async function apply() {
    const toEnable: string[] = [];
    const toDisable: string[] = [];
    for (const h of harnesses.map((x) => x.slug)) {
      const wasOn = initial.has(h);
      const isOn = selected.has(h);
      if (isOn && !wasOn) toEnable.push(h);
      if (!isOn && wasOn) toDisable.push(h);
    }
    setBusy(true);
    try {
      await onApply(toEnable, toDisable);
    } finally { setBusy(false); }
  }

  return (
    <div
      role="dialog"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460, maxWidth: '92vw', maxHeight: '80vh', overflowY: 'auto',
          background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 20, color: 'var(--fg)', boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Enable {slug} in…</div>
        <div style={{ fontSize: 12, color: 'var(--fg-mute)', marginBottom: 14 }}>
          Tick the harnesses where this plugin should be active. Per-harness configs use the plugin's defaults.
        </div>
        {harnesses.length === 0 ? (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--fg-mute)' }}>
            No harnesses installed yet. Install a template first.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {harnesses.map((h) => {
              const on = selected.has(h.slug);
              return (
                <li key={h.slug}>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                    border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
                    background: on ? 'var(--bg-1)' : 'transparent',
                  }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(h.slug)} />
                    <span style={{ flex: 1 }}>
                      <code style={{ fontSize: 13 }}>{h.slug}</code>
                      {h.version && <span style={{ fontSize: 11, color: 'var(--fg-mute)', marginLeft: 8 }}>v{h.version}</span>}
                    </span>
                    {initial.has(h.slug) && (
                      <span style={{ fontSize: 10, color: 'var(--good)', textTransform: 'uppercase' }}>currently enabled</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="pc-button" onClick={onCancel} disabled={busy} style={{ background: 'transparent', border: '1px solid var(--border)' }}>Cancel</button>
          <button className="pc-button" onClick={apply} disabled={busy || !dirty}>
            {busy ? 'Applying…' : dirty ? 'Apply' : 'No changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
