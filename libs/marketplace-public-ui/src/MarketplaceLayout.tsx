import React, { type ReactNode } from 'react';

const TABS: Array<{ href: string; label: string; hint: string }> = [
  { href: '/marketplace', label: 'Overview', hint: 'How it works' },
  { href: '/marketplace/templates', label: 'Templates', hint: 'Ready workflows' },
  { href: '/marketplace/plugins', label: 'Plugins', hint: 'Extra tools' },
  { href: '/marketplace/snapshots', label: 'Snapshots', hint: 'Saved setups' },
];

export function MarketplaceLayout({
  children,
  pathname = '',
}: {
  children: ReactNode;
  /** Current path, injected by the host router (was next/navigation's usePathname). */
  pathname?: string;
}) {
  return (
    <div className="pc-marketplace-frame">
      <nav className="pc-marketplace-tabs pc-tabs" role="tablist" aria-label="Marketplace sections">
        {TABS.map((t) => {
          const active = t.href === '/marketplace'
            ? pathname === '/marketplace' || pathname === '/marketplace/'
            : pathname.startsWith(t.href);
          return (
            <a
              key={t.href}
              href={t.href}
              role="tab"
              aria-selected={active}
              className={`pc-tab${active ? ' active' : ''}`}
            >
              <span className="pc-tab-label">{t.label}</span>
              <span className="pc-tab-hint">{t.hint}</span>
            </a>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
