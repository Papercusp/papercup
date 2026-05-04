'use client';

import RouteLink from '../_components/RouteLink';

import { usePathname } from 'next/navigation';

const SETTINGS_LINKS = [
  { href: '/settings/oracle', label: 'Oracle' },
  { href: '/settings/operator', label: 'Operator' },
  { href: '/settings/voice', label: 'Voice' },
  { href: '/settings/api-keys', label: 'API keys' },
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/publishing', label: 'Publishing' },
  { href: '/settings/plugin-runtime', label: 'Plugin runtime' },
  { href: '/settings/shortcuts', label: 'Keyboard shortcuts' },
] as const;

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';

  return (
    <div className="pc-settings-shell">
      <aside className="pc-settings-nav" aria-label="Settings sections">
        {SETTINGS_LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <RouteLink
              key={link.href}
              href={link.href}
              className="pc-settings-nav-link"
              aria-current={active ? 'page' : undefined}
            >
              {link.label}
            </RouteLink>
          );
        })}
      </aside>
      <section>{children}</section>
    </div>
  );
}
