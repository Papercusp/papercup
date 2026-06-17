'use client';

/**
 * Navbar branding switcher — a compact dropdown (mirrors ThemeSelector's
 * hand-rolled, portaled menu) that flips the entire brand bundle in one switch:
 * the lexicon (`useLexicon` → "Pot/Cupboard" vs "Hive/Comb"), the wordmark
 * (`OperatorWordmarkLockup`), the page title + favicon + forced theme
 * (`HiveThemeBridge`) — all of which key off the single `THE_HIVE` flag. So this
 * control just toggles that flag (POST /api/flags/set, the same write the
 * /admin/features page uses). It flips the flag in the client store
 * OPTIMISTICALLY so the reactive `useFlag` (lexicon + wordmark + HiveThemeBridge)
 * re-renders INSTANTLY, then the server write + SSE `flag_changed` reconcile it
 * (rolling back the local flip on failure). Without the optimistic apply the
 * switch waited on the whole POST → flag-bus → SSE → bootstrap-refetch round-trip
 * — which lags badly (and looks like "nothing happened") through the dev Vite SSE
 * proxy. Same pattern as the Force/Excl optimism (use-account-override).
 *
 * NOTE — branding is a WORKSPACE-GLOBAL flag (unlike the per-user color theme), so
 * switching here changes the brand for the whole install. And turning Hive ON forces
 * the `honeycomb` theme (HiveThemeBridge), so the theme picker is inert in Hive mode.
 *
 * Open-state lives in the URL (`?brandSwitch=`) per the repo nuqs rule, so the
 * dropdown is agent-driveable and survives reloads.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { Hexagon, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { FLAGS } from '@papercusp/flags';
import { getFlagSnapshot, setFlagPayload } from '@papercusp/flags/client';
import { useFlag } from '@/lib/flag-hooks';
import { Tooltip } from '../harness/Tooltip';

type BrandId = 'classic' | 'the-hive';

const BRANDS: ReadonlyArray<{ id: BrandId; label: string; hint: string; icon: typeof Hexagon }> = [
  { id: 'classic', label: 'Papercup', hint: 'mission console', icon: FileText },
  { id: 'the-hive', label: 'The Swarm', hint: 'Hive console · honeycomb theme', icon: Hexagon },
];

export default function BrandSwitcher() {
  const [open, setOpen] = useQueryState('brandSwitch', parseAsBoolean.withDefault(false));
  const hiveOn = useFlag(FLAGS.THE_HIVE);
  const activeId: BrandId = hiveOn ? 'the-hive' : 'classic';
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  // Outside-click / Escape close (mirrors ThemeSelector / WorkspaceSwitcher).
  useEffect(() => {
    if (!open) return;
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  // Anchor the portaled menu to the trigger; track layout shifts.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const active = BRANDS.find((b) => b.id === activeId) ?? BRANDS[0];
  const ActiveIcon = active.icon;

  const pick = async (id: BrandId) => {
    setOpen(false);
    if (id === activeId || busy) return;
    setBusy(true);
    const enabled = id === 'the-hive';
    // Optimistic flip: push the new flag value into the client store NOW so every
    // `useFlag(THE_HIVE)` consumer (lexicon, wordmark, HiveThemeBridge) re-renders
    // immediately, instead of waiting on POST → flag-bus → SSE → bootstrap-refetch.
    // Snapshot the prior payload so a failed write can roll the local flip back.
    const prev = getFlagSnapshot();
    setFlagPayload({ ...prev, flags: { ...prev.flags, [FLAGS.THE_HIVE]: enabled } });
    try {
      const res = await fetch('/api/flags/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: FLAGS.THE_HIVE, enabled }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      // Persisted. The SSE `flag_changed` → loadFlags() refetch reconciles to the
      // server truth (same value) — no flicker — and propagates to other clients.
    } catch (e) {
      setFlagPayload(prev); // roll back the optimistic flip
      toast.error('Couldn’t switch branding', { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span ref={wrapRef} className="pc-brand-switcher" style={{ position: 'relative', fontSize: 13 }}>
      <Tooltip label="Switch branding">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="pc-brand-trigger"
          disabled={busy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: '1px solid var(--border, #2a2a2a)',
            color: 'var(--fg-dim, #aaa)',
            padding: '3px 8px',
            borderRadius: 4,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            font: 'inherit',
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Switch branding"
        >
          <ActiveIcon size={13} aria-hidden />
          <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {active.label}
          </span>
          <span className="pc-brand-trigger-caret" style={{ opacity: 0.6 }}>▾</span>
        </button>
      </Tooltip>
      {open && menuPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Branding"
          className="pc-brand-menu pc-animate-in pc-animate-in--down pc-animate-in--fast"
          style={{
            position: 'fixed',
            top: menuPos.top,
            right: menuPos.right,
            minWidth: 220,
            background: '#0f1319',
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
            border: '1px solid #2a3344',
            borderRadius: 6,
            padding: 4,
            zIndex: 200,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04)',
          }}
        >
          <div style={{ padding: '4px 8px', color: 'var(--fg-mute, #777)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Branding
          </div>
          {BRANDS.map((b) => {
            const isCurrent = b.id === activeId;
            const Icon = b.icon;
            return (
              <button
                key={b.id}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => void pick(b.id)}
                className="pc-brand-menu-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  background: isCurrent ? 'var(--accent)' : 'transparent',
                  border: 'none',
                  color: isCurrent ? 'var(--accent-ink, #06121c)' : 'inherit',
                  cursor: 'pointer',
                  font: 'inherit',
                  padding: '6px 8px',
                  borderRadius: 3,
                }}
                title={isCurrent ? 'current branding' : `switch to ${b.label}`}
              >
                <Icon size={14} aria-hidden />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
                  <span style={{ display: 'block', fontSize: 10.5, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.hint}
                  </span>
                </span>
                {isCurrent && <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>●</span>}
              </button>
            );
          })}
          <div style={{ height: 1, background: 'var(--border, #2a2a2a)', margin: '4px 0' }} />
          <div style={{ padding: '4px 8px', color: 'var(--fg-mute, #777)', fontSize: 10.5, lineHeight: 1.4 }}>
            Applies to the whole workspace. Hive mode uses the honeycomb theme.
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
