'use client';

import { useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import { InstallButton, type InstallResult } from './InstallButton';

export interface CatalogEntry {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  plugins: string[];
  homepage?: string | null;
  kind?: 'plugin' | 'template' | 'snapshot';
  icon?: string | null;
  topology?: 'single' | 'multi';
  subprojects?: Array<{ suffix: string; kind: string; department_slug?: string }>;
  publishedAt?: string | null;
  publishedBy?: string | null;
  /** Downloads in the last 30 days. Operator passes this through from `/v1/popular`. */
  popularity30d?: number;
}

export type CatalogSortKey = 'newest' | 'popular' | 'name' | 'author';

export interface InstalledHarness {
  slug: string;
  version: string | null;
  description: string | null;
}

export interface InstalledPluginRecord {
  name: string;
  version?: string;
  description?: string;
  source: string;
  path: string;
  hidden?: boolean;
}

export interface MarketplaceActionResult {
  ok: boolean;
  error?: string;
  log?: string;
  results?: Array<{ ok: boolean; log?: string }>;
}

interface Props {
  kind: 'plugin' | 'template' | 'snapshot';
  catalog: CatalogEntry[];
  installedTemplates?: InstalledHarness[];
  installedPlugins?: InstalledPluginRecord[];
  enabledMap?: Record<string, string[]>;
  onInstallTemplate?: (slug: string, opts: { projectName: string; targetPath?: string }) => Promise<InstallResult>;
  onInstallPlugin?: (slug: string) => Promise<MarketplaceActionResult>;
  onUninstall?: (slug: string) => Promise<MarketplaceActionResult>;
  onEnable?: (slug: string, harnesses: string[], disable?: boolean) => Promise<MarketplaceActionResult>;
  onAfterChange?: () => void;
  notify?: (level: 'success' | 'error', msg: string, detail?: string) => void;
  q?: string;
  onQueryChange?: (q: string) => void;
}

function CardIcon({ name, kind }: { name: string | null | undefined; kind: 'plugin' | 'template' | 'snapshot' }) {
  const fallback = kind === 'plugin' ? Lucide.Puzzle : kind === 'snapshot' ? Lucide.Layers : Lucide.Package;
  const Icon = (name
    ? (Lucide as Record<string, unknown>)[name] as React.ComponentType<{ size?: number }>
    : undefined) ?? fallback;
  return (
    <span className={`pc-marketplace-card-icon ${kind}`}>
      <Icon size={18} />
    </span>
  );
}

export function MarketplaceList({
  kind,
  catalog,
  installedTemplates = [],
  installedPlugins = [],
  enabledMap = {},
  onInstallTemplate,
  onInstallPlugin,
  onUninstall,
  onEnable,
  onAfterChange,
  notify,
  q: qProp,
  onQueryChange,
}: Props) {
  const isPlugin = kind === 'plugin';
  const label = kind === 'plugin' ? 'plugins' : kind === 'snapshot' ? 'snapshots' : 'templates';
  const catalogForKind = useMemo(() => catalog.filter((c) => (c.kind ?? 'template') === kind), [catalog, kind]);
  const [qLocal, setQLocal] = useState('');
  const q = qProp ?? qLocal;
  const setQ = onQueryChange ?? setQLocal;
  const [sort, setSort] = useState<CatalogSortKey>('newest');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [enablePicker, setEnablePicker] = useState<string | null>(null);

  const installedSlugs = useMemo(() => {
    return new Set(isPlugin ? installedPlugins.map((p) => p.name) : installedTemplates.map((h) => h.slug));
  }, [isPlugin, installedPlugins, installedTemplates]);

  const filtered = useMemo<CatalogEntry[]>(() => catalogForKind, [catalogForKind]);

  const harnesses = installedTemplates;

  const visibleCatalog = useMemo(() => {
    const queried = q.trim()
      ? filtered.filter((p) => {
          const needle = q.toLowerCase();
          return [p.name, p.slug, p.description, p.author, p.license].some((v) => v?.toLowerCase().includes(needle));
        })
      : filtered;
    // Client-side sort. Catalog is small (<200 entries) and the
    // marketplace returns publishedAt-DESC by default, so 'newest' is
    // typically a no-op, but the explicit case keeps the UX self-evident.
    if (sort === 'name') {
      return [...queried].sort((a, b) => (a.name ?? a.slug).localeCompare(b.name ?? b.slug));
    }
    if (sort === 'author') {
      return [...queried].sort((a, b) => {
        const cmp = (a.author ?? '').localeCompare(b.author ?? '');
        return cmp !== 0 ? cmp : (a.name ?? a.slug).localeCompare(b.name ?? b.slug);
      });
    }
    if (sort === 'popular') {
      return [...queried].sort((a, b) => {
        const cmp = (b.popularity30d ?? 0) - (a.popularity30d ?? 0);
        return cmp !== 0 ? cmp : (a.name ?? a.slug).localeCompare(b.name ?? b.slug);
      });
    }
    return [...queried].sort((a, b) => {
      const aTs = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bTs = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return bTs - aTs;
    });
  }, [filtered, q, sort]);

  const installedCount = visibleCatalog.filter((entry) => installedSlugs.has(entry.slug)).length;

  async function uninstall(slug: string) {
    if (!onUninstall) return;
    if (!confirm(`Remove ${slug}?\n\n${isPlugin ? 'Plugin will be disabled in every harness it was enabled in.' : 'Projects you initialised from this template will be untouched.'}`)) return;
    setBusySlug(slug);
    try {
      const d = await onUninstall(slug);
      if (!d.ok) {
        notify?.('error', d.error ?? 'uninstall failed', d.log?.slice(-400));
        return;
      }
      notify?.('success', `${slug} removed`, d.log?.slice(-400));
      onAfterChange?.();
    } catch (e: any) {
      notify?.('error', `uninstall failed: ${e?.message ?? e}`);
    } finally {
      setBusySlug(null);
    }
  }

  async function enableIn(slug: string, harnessSlugs: string[]) {
    if (!onEnable || harnessSlugs.length === 0) return;
    setBusySlug(slug);
    try {
      const d = await onEnable(slug, harnessSlugs, false);
      if (!d.ok) {
        notify?.('error', d.error ?? 'enable failed', d.results?.find((x: any) => !x.ok)?.log?.slice(-400));
        return;
      }
      notify?.('success', `${slug} enabled in ${harnessSlugs.length} harness${harnessSlugs.length === 1 ? '' : 'es'}`);
      setEnablePicker(null);
    } catch (e: any) {
      notify?.('error', `enable failed: ${e?.message ?? e}`);
    } finally {
      setBusySlug(null);
    }
  }

  async function disableIn(slug: string, harnessSlugs: string[]) {
    if (!onEnable || harnessSlugs.length === 0) return;
    setBusySlug(slug);
    try {
      const d = await onEnable(slug, harnessSlugs, true);
      if (!d.ok) {
        notify?.('error', d.error ?? 'disable failed', d.results?.find((x: any) => !x.ok)?.log?.slice(-400));
        return;
      }
      notify?.('success', `${slug} disabled in ${harnessSlugs.length} harness${harnessSlugs.length === 1 ? '' : 'es'}`);
    } catch (e: any) {
      notify?.('error', `disable failed: ${e?.message ?? e}`);
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <section className="pc-marketplace-list">
      <div className="pc-marketplace-toolbar">
        <div className="pc-marketplace-toolbar-copy">
          <span>{kind === 'plugin' ? 'Plugin catalog' : kind === 'snapshot' ? 'Snapshot catalog' : 'Template catalog'}</span>
          <strong>{visibleCatalog.length} of {filtered.length} {label}</strong>
          {installedCount > 0 && <em>{installedCount} installed locally</em>}
        </div>
        <div className="pc-marketplace-search-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="pc-marketplace-search" style={{ flex: 1 }}>
            <Lucide.Search size={16} />
            <input
              type="search"
              placeholder={`Search ${label} by name, slug, description, or author…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <select
            aria-label="Sort catalog"
            className="pc-marketplace-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as CatalogSortKey)}
            style={{
              padding: '6px 10px',
              background: 'var(--bg-1)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--fg)',
              fontSize: 13,
              minWidth: 140,
            }}
          >
            <option value="newest">Newest published</option>
            <option value="popular">Most installed (30d)</option>
            <option value="name">Name (A→Z)</option>
            <option value="author">Author (A→Z)</option>
          </select>
        </div>
      </div>

      <div className="pc-marketplace-grid">
        {visibleCatalog.map((p) => {
          const installed = installedSlugs.has(p.slug);
          const enabledHere: string[] = isPlugin
            ? Object.entries(enabledMap).filter(([, slugs]) => slugs.includes(p.slug)).map(([h]) => h)
            : [];
          return (
            <article key={p.slug} className={`pc-card pc-marketplace-card${installed ? ' installed' : ''}`}>
              <div className="pc-marketplace-card-head">
                <CardIcon name={p.icon} kind={kind} />
                <div>
                  <a href={`/marketplace/${encodeURIComponent(p.slug)}`} className="pc-marketplace-card-title">
                    {p.name}
                  </a>
                  <span>{p.slug}</span>
                </div>
                {installed && <em>Installed</em>}
              </div>

              <p>{p.description}</p>

              <div className="pc-marketplace-meta">
                <span>v{p.version}</span>
                <span>{p.license}</span>
                {p.author && <span>{p.author}</span>}
                {!isPlugin && p.topology === 'multi' && p.subprojects && p.subprojects.length > 0 && (
                  <span className="accent">{p.subprojects.length} sub-harnesses</span>
                )}
              </div>

              {isPlugin && installed && enabledHere.length > 0 && (
                <div className="pc-marketplace-enabled">
                  <strong>Enabled in</strong>
                  {enabledHere.map((h) => <code key={h}>{h}</code>)}
                </div>
              )}

              <div className="pc-marketplace-card-actions">
                {!installed && (
                  isPlugin
                    ? <InstallPluginButton slug={p.slug} onInstall={onInstallPlugin} onAfterChange={onAfterChange} notify={notify} />
                    : <InstallButton
                        slug={p.slug}
                        alreadyInstalled={false}
                        topology={p.topology}
                        subprojects={p.subprojects}
                        onInstall={onInstallTemplate}
                        onSuccess={() => onAfterChange?.()}
                        notify={notify}
                      />
                )}
                {installed && isPlugin && onEnable && (
                  <button
                    className="pc-button ghost"
                    onClick={() => setEnablePicker(p.slug)}
                    disabled={busySlug === p.slug || harnesses.length === 0}
                    title={harnesses.length === 0 ? 'No harnesses installed' : 'Enable / disable in specific harnesses'}
                  >
                    Enable in harness…
                  </button>
                )}
                {installed && onUninstall && (
                  <button
                    className="pc-button danger"
                    onClick={() => uninstall(p.slug)}
                    disabled={busySlug === p.slug}
                  >
                    {busySlug === p.slug ? 'removing…' : 'Uninstall'}
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {visibleCatalog.length === 0 && (
          <div className="pc-card pc-marketplace-empty">
            <strong>{q.trim() ? `No ${label} match “${q}”` : `No ${label} published yet.`}</strong>
            <span>Try a broader search, or switch Marketplace tabs.</span>
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
    </section>
  );
}

function InstallPluginButton({
  slug,
  onInstall,
  onAfterChange,
  notify,
}: {
  slug: string;
  onInstall?: (slug: string) => Promise<MarketplaceActionResult>;
  onAfterChange?: () => void;
  notify?: (level: 'success' | 'error', msg: string, detail?: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  if (!onInstall) {
    return (
      <a
        className="pc-button primary"
        href={`/marketplace/${encodeURIComponent(slug)}`}
        onClick={(e) => e.stopPropagation()}
      >
        View details
      </a>
    );
  }

  async function go() {
    if (!onInstall) return;
    setBusy(true);
    try {
      const d = await onInstall(slug);
      if (!d.ok) {
        notify?.('error', d.error ?? 'install failed', d.log?.slice(-400));
        return;
      }
      notify?.('success', `${slug} installed`);
      onAfterChange?.();
    } catch (e: any) {
      notify?.('error', `install failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="pc-button" onClick={go} disabled={busy}>
      {busy ? 'Installing…' : 'Install plugin'}
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" className="pc-marketplace-dialog-backdrop" onClick={onCancel}>
      <div className="pc-marketplace-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pc-marketplace-dialog-title">Enable {slug} in…</div>
        <p>Tick the harnesses where this plugin should be active. Per-harness configs use the plugin's defaults.</p>
        {harnesses.length === 0 ? (
          <div className="pc-marketplace-empty compact">No harnesses installed yet. Install a template first.</div>
        ) : (
          <ul className="pc-marketplace-harness-list">
            {harnesses.map((h) => {
              const on = selected.has(h.slug);
              return (
                <li key={h.slug}>
                  <label className={on ? 'active' : ''}>
                    <input type="checkbox" checked={on} onChange={() => toggle(h.slug)} />
                    <span>
                      <code>{h.slug}</code>
                      {h.version && <em>v{h.version}</em>}
                    </span>
                    {initial.has(h.slug) && <b>enabled</b>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="pc-marketplace-dialog-actions">
          <button className="pc-button ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="pc-button" onClick={apply} disabled={busy || !dirty}>
            {busy ? 'Applying…' : dirty ? 'Apply changes' : 'No changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
