'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: Array<{ href: string; label: string; hint: string }> = [
  { href: '/marketplace', label: 'Overview', hint: 'Start here' },
  { href: '/marketplace/templates', label: 'Templates', hint: 'Harness recipes' },
  { href: '/marketplace/plugins', label: 'Plugins', hint: 'Capabilities' },
  { href: '/marketplace/snapshots', label: 'Snapshots', hint: 'Forkable state' },
];

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  return (
    <div className="pc-marketplace-frame">
      <nav className="pc-marketplace-tabs pc-tabs" role="tablist" aria-label="Marketplace sections">
        {TABS.map((t) => {
          const active = t.href === '/marketplace'
            ? pathname === '/marketplace' || pathname === '/marketplace/'
            : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              role="tab"
              aria-selected={active}
              className={`pc-tab${active ? ' active' : ''}`}
            >
              <span className="pc-tab-label">{t.label}</span>
              <span className="pc-tab-hint">{t.hint}</span>
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
