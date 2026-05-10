'use client';

import { useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTransitionRouter } from 'next-transition-router';
import RouteLink from '../_components/RouteLink';
import { Select } from '../harness/Select';

interface SettingsLink {
  readonly href: string;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly advanced?: boolean;
}

interface SettingsGroup {
  readonly label: string;
  readonly links: readonly SettingsLink[];
}

const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: 'Identity & devices',
    links: [
      { href: '/settings/profile', label: 'Profile', keywords: ['account', 'identity', 'email', 'display name', 'project directory'] },
      { href: '/settings/mobile', label: 'Mobile access', keywords: ['phone', 'device', 'pair', 'qr', 'workspace'] },
      { href: '/settings/publishing', label: 'Publishing', keywords: ['publish', 'preview', 'subdomain', 'public', 'marketplace'] },
    ],
  },
  {
    label: 'Assistants',
    links: [
      { href: '/settings/oracle', label: 'Oracle assistant', keywords: ['oracle', 'assistant', 'prompt', 'memory'] },
      { href: '/settings/operator', label: 'Operator agent', keywords: ['operator', 'agent', 'prompt', 'budget', 'preferences', 'approvals'] },
      { href: '/settings/voice', label: 'Voice & speech', keywords: ['voice', 'speech', 'stt', 'tts', 'microphone', 'wake word', 'elevenlabs', 'openai', 'cartesia', 'deepgram'] },
    ],
  },
  {
    label: 'Keys',
    links: [
      { href: '/settings/api-keys', label: 'API keys', keywords: ['credentials', 'keys', 'anthropic', 'openai', 'github', 'google', 'elevenlabs', 'cartesia', 'deepgram', 'picovoice'] },
    ],
  },
  {
    label: 'App preferences',
    links: [
      { href: '/settings/personalization', label: 'Personalization', keywords: ['visual effects', 'motion', 'theme', 'density', 'calm'] },
      { href: '/settings/shortcuts', label: 'Keyboard shortcuts', keywords: ['keyboard', 'shortcuts', 'hotkeys', 'bindings', 'commands'] },
    ],
  },
  {
    label: 'Advanced',
    links: [
      { href: '/settings/agent', label: 'AI backend', keywords: ['agent backend', 'claude', 'omp', 'meridian', 'models', 'roles', 'command'], advanced: true },
      { href: '/settings/omp', label: 'Oh-My-Pi (omp)', keywords: ['omp', 'oh my pi', 'web search', 'tavily', 'perplexity', 'brave', 'jina', 'kimi', 'exa', 'kagi', 'searxng', 'parallel', 'synthetic', 'hindsight', 'memory', 'thinking', 'compaction'], advanced: true },
      { href: '/settings/meridian', label: 'Meridian', keywords: ['meridian', 'telemetry', 'profiles', 'iframe'], advanced: true },
      { href: '/settings/plugin-runtime', label: 'Plugin runtime', keywords: ['plugin', 'runtime', 'hooks', 'load errors', 'cache'], advanced: true },
    ],
  },
];

const SETTINGS_LINKS = SETTINGS_GROUPS.flatMap((group) => group.links);

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useTransitionRouter();
  const [query, setQuery] = useState('');

  const activeLink = SETTINGS_LINKS.find((link) => pathname === link.href || pathname.startsWith(`${link.href}/`)) ?? SETTINGS_LINKS[0];
  const normalizedQuery = query.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return SETTINGS_GROUPS;
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    return SETTINGS_GROUPS
      .map((group) => ({
        ...group,
        links: group.links.filter((link) => {
          const haystack = [
            group.label,
            link.label,
            link.href.replace('/settings/', ''),
            ...link.keywords,
            link.advanced ? 'advanced debug diagnostics' : '',
          ].join(' ').toLowerCase();
          return terms.every((term) => haystack.includes(term));
        }),
      }))
      .filter((group) => group.links.length > 0);
  }, [normalizedQuery]);

  return (
    <div className="pc-settings-shell">
      <aside className="pc-settings-nav" aria-label="Settings sections">
        <div className="pc-settings-nav-search">
          <label className="pc-settings-nav-search-label" htmlFor="settings-nav-search">Search</label>
          <input
            id="settings-nav-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings…"
            className="pc-settings-nav-search-input"
          />
        </div>

        <div className="pc-settings-mobile-picker">
          <Select
            value={activeLink.href}
            onChange={(href) => router.push(href)}
            ariaLabel="Settings page"
            options={SETTINGS_GROUPS.flatMap((group) =>
              group.links.map((link) => ({
                value: link.href,
                label: `${link.label} · ${group.label}`,
              })),
            )}
            triggerClassName="pc-settings-mobile-trigger"
            contentStyle={{ zIndex: 90 }}
          />
        </div>

        <nav className="pc-settings-nav-groups" aria-label="Settings pages">
          {visibleGroups.length === 0 ? (
            <div className="pc-settings-nav-empty">No settings match “{query.trim()}”.</div>
          ) : (
            visibleGroups.map((group) => (
              <div key={group.label} className="pc-settings-nav-group">
                <div className="pc-settings-nav-heading">{group.label}</div>
                {group.links.map((link) => {
                  const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
                  return (
                    <RouteLink
                      key={link.href}
                      href={link.href}
                      className="pc-settings-nav-link"
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="pc-settings-nav-link-label">{link.label}</span>
                      {link.advanced && <span className="pc-settings-nav-chip">Advanced</span>}
                    </RouteLink>
                  );
                })}
              </div>
            ))
          )}
        </nav>
      </aside>
      <section className="pc-settings-content">{children}</section>
    </div>
  );
}
