'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * Admin section shell — modeled on Restart's DashboardShell. Each
 * admin sub-route imports this and wraps its content with it. Active
 * tab is computed from `window.location.pathname`. Tabs are real
 * <Link> elements (separate routes), not in-page state.
 */
const TABS = [
  { href: '/admin/run',      label: 'Run' },
  { href: '/admin/features', label: 'Features' },
];

export default function AdminShell({
  title = 'Admin',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const [pathname, setPathname] = useState('/');
  useEffect(() => {
    setPathname(window.location.pathname);
  }, []);

  return (
    <div className="pc-admin-shell">
      <header className="pc-admin-header">
        <h1>{title}</h1>
        <nav className="pc-admin-tabs">
          {TABS.map((t) => {
            const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`pc-admin-tab${active ? ' active' : ''}`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <span className="pc-admin-spacer" />
        <span className="pc-admin-host">localhost · :3055</span>
      </header>
      <div className="pc-admin-body">{children}</div>
      <style>{`
        .pc-admin-shell { display: flex; flex-direction: column; min-height: calc(100vh - 56px); }
        .pc-admin-header {
          display: flex; align-items: center; gap: 16px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--border, #2a2a2a);
          background: var(--surface-1, #0a0a0a);
        }
        .pc-admin-header h1 { margin: 0; font-size: 16px; font-weight: 600; color: var(--text-1, #e5e7eb); }
        .pc-admin-tabs { display: flex; gap: 4px; margin-left: 12px; }
        .pc-admin-tab {
          padding: 4px 10px;
          border-radius: 6px;
          font-size: 13px;
          color: var(--text-2, #9ca3af);
          background: transparent;
          border: 1px solid transparent;
          text-decoration: none !important;
          transition: color 120ms, background-color 120ms, border-color 120ms;
        }
        .pc-admin-tab:hover {
          color: var(--text-1, #e5e7eb);
          background: var(--surface-2, #161616);
          border-color: var(--border, #2a2a2a);
          text-decoration: none !important;
        }
        .pc-admin-tab.active {
          color: var(--text-1, #e5e7eb);
          background: var(--surface-2, #161616);
          border-color: var(--border, #2a2a2a);
        }
        .pc-admin-spacer { flex: 1; }
        .pc-admin-host { color: var(--text-2, #9ca3af); font-size: 12px; font-family: ui-monospace, monospace; }
        .pc-admin-body { flex: 1; min-height: 0; overflow: auto; }
      `}</style>
    </div>
  );
}
