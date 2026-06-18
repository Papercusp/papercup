'use client';


/**
 * Navbar theme selector — a compact dropdown (mirrors WorkspaceSwitcher's
 * hand-rolled, portaled menu) that switches the active color theme instantly
 * and persists it the SAME way the personalization settings page does:
 * `writeActiveTheme()` → PG via /api/profile (source of truth) + a localStorage
 * write-through cache (see lib/theme.ts + lib/profile-pref.ts). Lists the
 * built-in themes plus any custom themes; "Manage themes…" opens the full
 * editor in settings.
 *
 * Open-state lives in the URL (`?themeSwitch=`) per the repo nuqs rule, so the
 * dropdown is agent-driveable and survives reloads.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { Tooltip } from '../harness/Tooltip';
import RouteLink from './RouteLink';
import {
  fetchCustomThemes,
  themeList,
  useActiveTheme,
  writeActiveTheme,
  type CustomTheme,
} from '@/lib/theme';

/** Tiny per-theme accent dot. Scopes `data-theme` so `var(--accent)` resolves
 *  to THAT theme's accent regardless of the page's active theme — the same
 *  trick the settings ThemePreview uses. */
function ThemeSwatch({ themeId }: { themeId: string }) {
  return (
    <span
      data-theme={themeId}
      aria-hidden
      style={{
        width: 12,
        height: 12,
        flex: '0 0 auto',
        borderRadius: 3,
        background: 'var(--accent)',
        border: '1px solid var(--border-strong, #2a2a2a)',
      }}
    />
  );
}

export default function ThemeSelector() {
  const [open, setOpen] = useQueryState('themeSwitch', parseAsBoolean.withDefault(false));
  const activeTheme = useActiveTheme();
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  // Load custom themes so they show alongside the built-ins. Fails quietly:
  // the /api/themes endpoint is unavailable until the operator restarts after
  // a fresh install; the built-ins still switch.
  useEffect(() => {
    let alive = true;
    fetchCustomThemes()
      .then((t) => { if (alive) setCustomThemes(t); })
      .catch(() => { /* built-ins still work */ });
    return () => { alive = false; };
  }, []);

  // Outside-click / Escape close (mirrors WorkspaceSwitcher).
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

  const themes = themeList(customThemes);
  const activeLabel = themes.find((t) => t.id === activeTheme)?.label ?? 'Theme';

  const pick = (id: string) => {
    writeActiveTheme(id);
    setOpen(false);
  };

  return (
    <span ref={wrapRef} className="pc-theme-switcher" style={{ position: 'relative', fontSize: 13 }}>
      <Tooltip label="Switch theme">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="pc-theme-trigger"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: '1px solid var(--border, #2a2a2a)',
            color: 'var(--fg-dim, #aaa)',
            padding: '3px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            font: 'inherit',
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Switch theme"
        >
          <ThemeSwatch themeId={activeTheme} />
          <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeLabel}
          </span>
          <span className="pc-theme-trigger-caret" style={{ opacity: 0.6 }}>▾</span>
        </button>
      </Tooltip>
      {open && menuPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Theme"
          className="pc-theme-menu pc-animate-in pc-animate-in--down pc-animate-in--fast"
          style={{
            position: 'fixed',
            top: menuPos.top,
            right: menuPos.right,
            minWidth: 200,
            // Solid hex + backdrop-filter:none, portaled to <body> so it escapes
            // the sticky header stacking context — identical treatment to the
            // workspace menu (otherwise the OracleDock z:80 paints over it).
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
            Theme
          </div>
          {themes.map((t) => {
            const isCurrent = t.id === activeTheme;
            return (
              <Tooltip key={t.id} label={isCurrent ? 'current theme' : `switch to ${t.label}`}><button

                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => pick(t.id)}
                className="pc-theme-menu-item"
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
                  padding: '5px 8px',
                  borderRadius: 3,
                }}

              >
                <ThemeSwatch themeId={t.id} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.label}
                </span>
                {isCurrent && <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>●</span>}
              </button></Tooltip>
            );
          })}
          <div style={{ height: 1, background: 'var(--border, #2a2a2a)', margin: '4px 0' }} />
          <RouteLink
            href="/settings/personalization"
            onClick={() => setOpen(false)}
            className="pc-theme-menu-manage"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              color: 'var(--fg-dim, #aaa)',
              textDecoration: 'none',
              font: 'inherit',
              padding: '4px 8px',
              borderRadius: 3,
            }}
          >
            Manage themes…
          </RouteLink>
        </div>,
        document.body,
      )}
    </span>
  );
}
