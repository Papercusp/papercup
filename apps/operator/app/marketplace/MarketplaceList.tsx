'use client';

import { useProgress } from '@bprogress/next';

import { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { useReducedMotion } from 'motion/react';
import { useQueryState, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import * as Lucide from 'lucide-react';
import { Checkbox } from '../harness/Checkbox';
import InstallButton from './InstallButton';
import RouteLink from '../_components/RouteLink';

gsap.registerPlugin(useGSAP);

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
  /** Manifest-declared marketplace-hidden flag — see plugin-sdk Plugin.hidden. */
  hidden?: boolean;
}

interface Props {
  kind: 'plugin' | 'template';
  catalog: CatalogEntry[];
  installedTemplates: InstalledHarness[];
  installedPlugins: InstalledPluginRecord[];
}

function CardIcon({ name, kind }: { name: string | null | undefined; kind: 'plugin' | 'template' }) {
  const fallback = kind === 'plugin' ? Lucide.Puzzle : Lucide.Package;
  const Icon: React.ComponentType<{ size?: number }> = (name && (Lucide as Record<string, unknown>)[name] as React.ComponentType<{ size?: number }>) || fallback;
  return (
    <span className={`pc-marketplace-card-icon ${kind === 'plugin' ? 'plugin' : 'template'}`}>
      <Icon size={18} />
    </span>
  );
}

export default function MarketplaceList({ kind, catalog, installedTemplates, installedPlugins }: Props) {
  const listRef = useRef<HTMLElement | null>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const isPlugin = kind === 'plugin';
  const label = isPlugin ? 'plugins' : 'templates';
  const catalogForKind = useMemo(() => catalog.filter((c) => (c.kind ?? 'template') === kind), [catalog, kind]);
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [enablePicker, setEnablePicker] = useState<string | null>(null);
  const [enabledMap, setEnabledMap] = useState<Record<string, string[]>>({});
  const progress = useProgress();

  const installedSlugs = useMemo(() => {
    return new Set(isPlugin ? installedPlugins.map((p) => p.name) : installedTemplates.map((h) => h.slug));
  }, [isPlugin, installedPlugins, installedTemplates]);

  const filtered = useMemo<CatalogEntry[]>(() => {
    const bySlug = new Map(catalogForKind.map((entry) => [entry.slug, entry]));
    if (isPlugin) {
      for (const plugin of installedPlugins) {
        // Manifest-declared marketplace-hidden plugins don't appear as catalog
        // cards. They still load and run; this just suppresses discovery.
        if (plugin.hidden) continue;
        if (!bySlug.has(plugin.name)) {
          bySlug.set(plugin.name, {
            slug: plugin.name,
            name: plugin.name,
            version: plugin.version ?? 'local',
            description: plugin.description ?? `Installed from ${plugin.source}.`,
            author: plugin.source,
            license: 'local',
            plugins: [],
            kind: 'plugin',
          });
        }
      }
    } else {
      for (const harness of installedTemplates) {
        if (!bySlug.has(harness.slug)) {
          bySlug.set(harness.slug, {
            slug: harness.slug,
            name: harness.slug,
            version: harness.version ?? 'local',
            description: harness.description ?? 'Installed local harness template.',
            author: 'local install',
            license: 'local',
            plugins: [],
            kind: 'template',
          });
        }
      }
    }
    return Array.from(bySlug.values());
  }, [catalogForKind, installedPlugins, installedTemplates, isPlugin]);

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
      [p.name, p.slug, p.description, p.author, p.license].some((v) => v?.toLowerCase().includes(needle)),
    );
  }, [filtered, q]);

  const installedCount = visibleCatalog.filter((entry) => installedSlugs.has(entry.slug)).length;

  async function uninstall(slug: string) {
    if (!confirm(`Remove ${slug}?\n\n${isPlugin ? 'Plugin will be disabled in every harness it was enabled in.' : 'Projects you initialised from this template will be untouched.'}`)) return;
    setBusySlug(slug);
    progress.start(0.08, 0, true);
    let stopProgress = true;
    try {
      const url = isPlugin ? '/api/plugins/uninstall' : '/api/marketplace/uninstall';
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d.error ?? 'uninstall failed', { description: d.log?.slice(-400) });
        return;
      }
      toast.success(`${slug} removed`, { description: d.log?.slice(-400) });
      stopProgress = false;
      setTimeout(() => window.location.reload(), 600);
    } catch (e: any) {
      toast.error(`uninstall failed: ${e?.message ?? e}`);
    } finally {
      setBusySlug(null);
      if (stopProgress) progress.stop(120);
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

  useGSAP(
    () => {
      if (!listRef.current || reducedMotion) return;
      const q = gsap.utils.selector(listRef.current);
      const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });

      intro
        .fromTo(
          q('.pc-marketplace-toolbar-copy, .pc-marketplace-search'),
          { autoAlpha: 0, y: -18 },
          { autoAlpha: 1, y: 0, duration: 0.44, stagger: 0.06 },
          0,
        )
        .fromTo(
          q('.pc-marketplace-card, .pc-marketplace-empty'),
          { autoAlpha: 0, y: 28, rotateX: 10 },
          { autoAlpha: 1, y: 0, rotateX: 0, duration: 0.54, stagger: 0.06 },
          0.12,
        );

      const sweep = gsap.to(q('.pc-marketplace-card'), {
        boxShadow: '0 20px 42px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(125, 211, 252, 0.06)',
        duration: 2.4,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true,
        stagger: 0.16,
      });

      return () => {
        intro.kill();
        sweep.kill();
      };
    },
    { scope: listRef, dependencies: [kind, visibleCatalog.length, enablePicker, reducedMotion] },
  );

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
    <section ref={listRef} className="pc-marketplace-list pc-marketplace-list--maximal-hud" data-marketplace-kind={kind}>
      <div className="pc-marketplace-toolbar">
        <div className="pc-marketplace-toolbar-copy">
          <span>{isPlugin ? 'Plugin catalog' : 'Template catalog'}</span>
          <strong>{visibleCatalog.length} of {filtered.length} {label}</strong>
          <em>{installedCount} installed locally</em>
        </div>
        <label className="pc-marketplace-search">
          <Lucide.Search size={16} />
          <input
            type="search"
            placeholder={`Search ${label} by name, slug, description, or author…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>

      <div className="pc-marketplace-grid">
        {visibleCatalog.map((p, index) => {
          const installed = installedSlugs.has(p.slug);
          const enabledHere: string[] = isPlugin
            ? Object.entries(enabledMap).filter(([, slugs]) => slugs.includes(p.slug)).map(([h]) => h)
            : [];
          return (
            <article key={p.slug} data-card-index={index} className={`pc-card pc-marketplace-card${installed ? ' installed' : ''}`}>
              <div className="pc-marketplace-card-head">
                <CardIcon name={p.icon} kind={kind} />
                <div>
                  <RouteLink href={`/marketplace/${encodeURIComponent(p.slug)}`} className="pc-marketplace-card-title">
                    {p.name}
                  </RouteLink>
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
                    ? <InstallPluginButton slug={p.slug} />
                    : <InstallButton slug={p.slug} alreadyInstalled={false} topology={p.topology} subprojects={p.subprojects} />
                )}
                {installed && isPlugin && (
                  <button
                    className="pc-button ghost"
                    onClick={() => setEnablePicker(p.slug)}
                    disabled={busySlug === p.slug || harnesses.length === 0}
                    title={harnesses.length === 0 ? 'No harnesses installed' : 'Enable / disable in specific harnesses'}
                  >
                    Enable in harness…
                  </button>
                )}
                {installed && (
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

function InstallPluginButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  const progress = useProgress();
  async function go() {
    setBusy(true);
    progress.start(0.08, 0, true);
    let stopProgress = true;
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
      stopProgress = false;
      setTimeout(() => window.location.reload(), 600);
    } catch (e: any) {
      toast.error(`install failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
      if (stopProgress) progress.stop(120);
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
                    <Checkbox checked={on} onChange={() => toggle(h.slug)} ariaLabel={`Select ${h.slug}`} />
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