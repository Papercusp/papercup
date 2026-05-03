'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { Tooltip } from './Tooltip';
import { Play, Square, Activity, AlertTriangle, ExternalLink, ChevronDown, Settings } from 'lucide-react';

const BranchActionRunner = dynamic(() => import('../_components/BranchActionRunner'), { ssr: false });

interface MissingEnvEntry {
  name: string;
  from: 'plugin' | 'config' | 'harness' | 'literal';
  plugin?: string;
  field?: string;
  description?: string;
}

interface ActionEntry {
  name: string;
  source: 'harness' | 'plugin';
  pluginSlug?: string;
  displayName: string;
  description?: string;
  scriptPath: string;
  envStatus: { ok: boolean; resolved: string[]; missing: MissingEnvEntry[] };
  lastRun: { runId: string; status: string; endedAt?: string; exitCode?: number | null } | null;
}

export type Phase = 'staging' | 'testing' | 'production';

export interface PhaseInfo {
  phase: Phase;
  path: string;
  branch: string;
  port: number | null;
  publicUrl: string | null;
  exists: boolean;
  alive: boolean;
  passed: number;
  total: number;
  cost: number;
  iteration: number;
  promotionInFlight: string | null;
}

interface Props {
  slug: string;
  activePhase: Phase;
  onChange: (p: Phase) => void;
}

const PHASE_ORDER: Phase[] = ['staging', 'testing', 'production'];
const PHASE_COLOR: Record<Phase, string> = {
  staging: '#3b82f6',
  testing: '#a855f7',
  production: '#10b981',
};

export default function PhaseTabs({ slug, activePhase, onChange }: Props) {
  const [phases, setPhases] = useState<PhaseInfo[]>([]);
  const [health, setHealth] = useState<Record<Phase, 'up' | 'slow' | 'down' | 'unknown'>>({
    staging: 'unknown', testing: 'unknown', production: 'unknown',
  });
  const [actions, setActions] = useState<Record<Phase, ActionEntry[]>>({
    staging: [], testing: [], production: [],
  });
  const [openMenu, setOpenMenu] = useState<Phase | null>(null);
  const [running, setRunning] = useState<{ branch: Phase; name: string } | null>(null);

  // Discover actions per branch
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next: Record<Phase, ActionEntry[]> = { staging: [], testing: [], production: [] };
      await Promise.all(PHASE_ORDER.map(async (b) => {
        try {
          const r = await fetch(`/api/harness/${slug}/branch/${b}/actions`);
          if (!r.ok) return;
          const d = await r.json();
          if (Array.isArray(d.actions)) next[b] = d.actions;
        } catch { /* ignore */ }
      }));
      if (alive) setActions(next);
    };
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [slug]);

  // The menu is portal'd to document.body to escape any clipping ancestor
  // (the phase strip lives inside `.h-project-phases` which has compact
  // styling that can hide an absolute-positioned descendant). We pin its
  // position to the chip's bounding rect.
  const chipRefs = useRef<Record<Phase, HTMLButtonElement | null>>({
    staging: null, testing: null, production: null,
  });
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const justOpenedRef = useRef(false);

  // Position the portal'd menu under its chip whenever it opens.
  useEffect(() => {
    if (!openMenu) { setMenuPos(null); return; }
    const anchor = chipRefs.current[openMenu];
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left });
  }, [openMenu]);

  // Close menu on outside click. mousedown so menu items' clicks still
  // fire (click runs after mousedown). justOpenedRef skips the very
  // first event after open so the same click that opened it doesn't
  // close it.
  useEffect(() => {
    if (!openMenu) { justOpenedRef.current = false; return; }
    justOpenedRef.current = true;
    const tick = setTimeout(() => { justOpenedRef.current = false; }, 0);
    const onDown = (e: MouseEvent) => {
      if (justOpenedRef.current) return;
      if (menuContainerRef.current?.contains(e.target as Node)) return;
      // Also ignore clicks on the open chip itself (its own onClick handles toggle)
      if (chipRefs.current[openMenu]?.contains(e.target as Node)) return;
      setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      clearTimeout(tick);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openMenu]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await fetch(`/api/harness/${slug}/phases`).then((r) => r.json());
        if (alive && d.phases) setPhases(d.phases);
      } catch {}
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [slug]);

  // Health pings — poll each phase's port
  useEffect(() => {
    let cancelled = false;
    const pingAll = async () => {
      const next: Record<Phase, 'up' | 'slow' | 'down' | 'unknown'> = { ...health };
      // Only probe localhost dev servers when the admin app is itself running
      // on localhost. Otherwise (public-site embed) the localhost ports are
      // unreachable and the fetch generates CSP / connection-refused noise.
      const onLocalhost =
        typeof window !== 'undefined' &&
        /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(window.location.hostname);

      for (const p of phases) {
        if (!p.port) { next[p.phase] = 'unknown'; continue; }
        if (!onLocalhost) { next[p.phase] = 'unknown'; continue; }
        try {
          const start = Date.now();
          const res = await fetch(`http://localhost:${p.port}/`, { mode: 'no-cors' as any, signal: AbortSignal.timeout(3000) }).catch(() => null);
          const elapsed = Date.now() - start;
          if (!res) next[p.phase] = 'down';
          else if (elapsed > 1500) next[p.phase] = 'slow';
          else next[p.phase] = 'up';
        } catch {
          next[p.phase] = 'down';
        }
      }
      if (!cancelled) setHealth(next);
    };
    pingAll();
    const t = setInterval(pingAll, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [phases]); // eslint-disable-line react-hooks/exhaustive-deps

  const showSetup = phases.length > 0 && phases.some((p) => !p.exists && p.phase !== 'staging');

  const setup = async () => {
    if (!confirm('Create testing + production worktrees for this project?')) return;
    const res = await fetch(`/api/harness/${slug}/phases/setup`, { method: 'POST' });
    const body = await res.json();
    if (res.ok) alert('phases created\n\n' + (body.output ?? ''));
    else alert('setup failed: ' + (body.error ?? res.statusText));
  };

  return (
    <>
    <div className="h-phase-strip" style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 10px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-2)',
      flexWrap: 'wrap',
    }}>
      <span className="h-phase-label" style={{
        fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--fg-dim)', fontWeight: 600, marginRight: 4,
      }}>Phases</span>
      {PHASE_ORDER.map((p) => {
        const info = phases.find((x) => x.phase === p);
        const isActive = activePhase === p;
        const exists = info?.exists ?? (p === 'staging');
        const color = PHASE_COLOR[p];
        const h = health[p];
        return (
          <div
            key={p}
            className={`h-phase-item phase-${p}${isActive ? ' active' : ''}${exists ? '' : ' disabled'}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px',
              background: isActive ? 'color-mix(in oklab, var(--bg-2), white 4%)' : 'transparent',
              border: `1px solid ${isActive ? color : 'var(--border)'}`,
              borderRadius: 4,
              cursor: exists ? 'pointer' : 'not-allowed',
              opacity: exists ? 1 : 0.45,
              fontSize: 11,
            }}
            onClick={() => exists && onChange(p)}
          >
            <span className="h-phase-dot" style={{
              width: 7, height: 7, borderRadius: '50%',
              background:
                h === 'up' ? '#10b981' :
                h === 'slow' ? '#f59e0b' :
                h === 'down' ? '#ef4444' :
                'var(--border)',
              boxShadow: info?.alive ? `0 0 0 2px color-mix(in oklab, ${color}, transparent 70%)` : 'none',
              animation: info?.alive ? 'hPulse 1.6s infinite' : 'none',
            }} />
            <span className="h-phase-name" style={{ color: exists ? 'var(--fg)' : 'var(--fg-dim)', fontWeight: isActive ? 600 : 400 }}>
              {p}
            </span>
            {info?.exists && (
              <>
                <span className="h-phase-meta" style={{ color: 'var(--fg-dim)', fontSize: 10 }}>
                  {info.passed}/{info.total} · iter {info.iteration}
                </span>
                {info.cost > 0 && (
                  <span className="h-phase-cost" style={{ color: 'var(--fg-dim)', fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>
                    ${info.cost.toFixed(2)}
                  </span>
                )}
                {info.promotionInFlight && (
                  <Tooltip label="Promotion in progress">
                    <span style={{ color: '#f59e0b', display: 'inline-flex' }}>
                      <AlertTriangle size={10} />
                    </span>
                  </Tooltip>
                )}
                {actions[p].length > 0 && (() => {
                  const anyMissing = actions[p].some((a) => !a.envStatus.ok);
                  const chipColor = anyMissing ? '#f59e0b' : color;
                  return (
                    <button
                      type="button"
                      ref={(el) => { chipRefs.current[p] = el; }}
                      className="h-phase-actions-btn"
                      onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === p ? null : p); }}
                      onMouseDown={(e) => e.stopPropagation()}
                      title={anyMissing ? `One or more ${p} actions need keys configured` : `Run a ${p} action`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                        padding: '2px 6px', marginLeft: 2,
                        fontSize: 10, color: chipColor,
                        background: `color-mix(in oklab, ${chipColor}, transparent 88%)`,
                        border: `1px solid color-mix(in oklab, ${chipColor}, transparent 60%)`,
                        borderRadius: 3, cursor: 'pointer', fontWeight: 600,
                        pointerEvents: 'auto',
                      }}
                    >
                      {anyMissing && <AlertTriangle size={10} />}
                      actions <ChevronDown size={10} />
                    </button>
                  );
                })()}
                {(info.publicUrl || info.port) && (() => {
                  const localUrl = info.port ? `http://localhost:${info.port}/` : null;
                  const isLocalhost = typeof window !== 'undefined' && window.location.hostname === 'localhost';
                  const href = isLocalhost ? (localUrl ?? info.publicUrl) : (info.publicUrl ?? localUrl);
                  if (!href) return null;
                  return (
                    <a
                      className="h-phase-open"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        padding: '2px 7px',
                        marginLeft: 2,
                        fontSize: 10,
                        color: color,
                        background: `color-mix(in oklab, ${color}, transparent 88%)`,
                        border: `1px solid color-mix(in oklab, ${color}, transparent 60%)`,
                        borderRadius: 3,
                        textDecoration: 'none',
                        fontWeight: 600,
                      }}
                      title={`Open the ${p} app at ${href}`}
                    >
                      open <ExternalLink size={10} />
                    </a>
                  );
                })()}
              </>
            )}
          </div>
        );
      })}
      {showSetup && (
        <button
          className="h-phase-setup"
          onClick={setup}
          style={{
            marginLeft: 'auto',
            fontSize: 10, padding: '3px 8px',
            background: 'var(--accent, #5e6ad2)', color: 'white', border: 'none',
            borderRadius: 3, cursor: 'pointer',
          }}
        >Set up phases</button>
      )}
    </div>
    {openMenu && menuPos && typeof document !== 'undefined' && createPortal(
      <div
        ref={menuContainerRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', top: menuPos.top, left: menuPos.left,
          background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 4, padding: 4, minWidth: 180, zIndex: 1000,
          boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
        }}
      >
        {actions[openMenu].map((a) => {
          const blocked = !a.envStatus.ok;
          const firstMissing = a.envStatus.missing[0];
          const configurePlugin = firstMissing?.plugin;
          return (
            <div
              key={a.name}
              style={{
                display: 'flex', flexDirection: 'column',
                gap: 2,
                padding: '6px 8px',
                borderRadius: 3,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in oklab, var(--bg-2), white 6%)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <button
                type="button"
                disabled={blocked}
                onClick={(e) => {
                  e.stopPropagation();
                  if (blocked) return;
                  const branch = openMenu;
                  setOpenMenu(null);
                  if (branch) setRunning({ branch, name: a.name });
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none', padding: 0,
                  color: blocked ? '#f59e0b' : 'var(--fg)',
                  cursor: blocked ? 'not-allowed' : 'pointer',
                  opacity: blocked ? 0.85 : 1,
                  fontSize: 12, fontWeight: 600,
                }}
                title={blocked ? `Missing: ${a.envStatus.missing.map((m) => m.name).join(', ')}` : a.description ?? ''}
              >
                {blocked && <AlertTriangle size={11} />}
                <span>{a.displayName}</span>
                {a.source === 'plugin' && (
                  <span style={{ fontSize: 9, color: 'var(--fg-dim)', fontWeight: 400 }}>
                    {a.pluginSlug}
                  </span>
                )}
              </button>
              {blocked && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10 }}>
                  <span style={{ color: '#f59e0b' }}>
                    needs: {a.envStatus.missing.map((m) => m.name).join(', ')}
                  </span>
                  {configurePlugin && (
                    <a
                      href={`/harness/${slug}?panel=plugins&plugin=${encodeURIComponent(configurePlugin)}`}
                      onClick={(e) => { e.stopPropagation(); setOpenMenu(null); }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        color: '#58a6ff', textDecoration: 'none',
                      }}
                    >
                      <Settings size={10} /> configure {configurePlugin}
                    </a>
                  )}
                </div>
              )}
              {!blocked && a.lastRun && (
                <span style={{
                  fontSize: 10,
                  color: a.lastRun.status === 'completed' ? '#3fb950' :
                         a.lastRun.status === 'failed' ? '#f85149' :
                         '#58a6ff',
                }}>
                  last: {a.lastRun.status}{a.lastRun.endedAt ? ` · ${a.lastRun.endedAt.slice(11, 19)}` : ''}
                </span>
              )}
            </div>
          );
        })}
      </div>,
      document.body,
    )}
    {running && (
      <BranchActionRunner
        slug={slug}
        branch={running.branch}
        name={running.name}
        onClose={() => setRunning(null)}
      />
    )}
    </>
  );
}
