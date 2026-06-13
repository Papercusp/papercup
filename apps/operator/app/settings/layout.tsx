'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from '@/lib/router-compat/navigation';
import RouteLink from '../_components/RouteLink';
import { Select } from '../harness/Select';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';

const SETTINGS_PATH_FLAGS: Record<string, FlagKey> = {
  '/settings/publishing': FLAGS.CLOUDFLARE_PUBLISH,
  '/settings/oracle':     FLAGS.TESTING,
  '/settings/prompt-studio': FLAGS.PROMPT_STUDIO,
  '/settings/autonomy':   FLAGS.QUEEN_AUTONOMY_SETTINGS,
};

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
    label: 'Get started',
    links: [
      { href: '/settings/setup-wizard', label: 'Setup Wizard', keywords: ['setup', 'wizard', 'onboarding', 'first run', 'install', 'permissions', 'workspace', 'keys', 'login', 'pair'] },
    ],
  },
  {
    label: 'Identity & devices',
    links: [
      { href: '/settings/profile', label: 'Profile', keywords: ['account', 'identity', 'email', 'display name', 'project directory'] },
      { href: '/settings/user', label: 'User preferences', keywords: ['user', 'me', 'override', 'password', 'session', 'logout'] },
      { href: '/settings/mobile', label: 'Mobile access', keywords: ['phone', 'device', 'pair', 'qr', 'workspace'] },
      { href: '/settings/publishing', label: 'Publishing', keywords: ['publish', 'preview', 'subdomain', 'public', 'marketplace'] },
    ],
  },
  {
    label: 'Assistants',
    links: [
      { href: '/settings/oracle', label: 'Oracle assistant', keywords: ['oracle', 'assistant', 'prompt', 'memory'] },
      { href: '/settings/operator', label: 'Papercup agent', keywords: ['operator', 'agent', 'prompt', 'budget', 'preferences', 'approvals'] },
      { href: '/settings/autonomy', label: 'Autonomy', keywords: ['autonomy', 'policy', 'ceiling', 'graduated', 'queen', 'auto', 'auto-decide', 'risk', 'protected', 'lock', 'escalation'] },
      { href: '/settings/voice', label: 'Voice & speech', keywords: ['voice', 'speech', 'stt', 'tts', 'microphone', 'wake word', 'elevenlabs', 'openai', 'cartesia', 'deepgram'] },
    ],
  },
  {
    label: 'Keys & OAuth',
    links: [
      { href: '/settings/api-keys', label: 'Keys & OAuth', keywords: ['credentials', 'keys', 'oauth', 'login', 'sign in', 'claude', 'chatgpt', 'anthropic', 'openai', 'github', 'google', 'elevenlabs', 'cartesia', 'deepgram', 'picovoice'] },
      { href: '/settings/deploy-accounts', label: 'Deploy accounts', keywords: ['deploy', 'deployment', 'accounts', 'credentials', 'claude', 'oauth', 'setup-token', 'remote frame', 'per-machine', 'pool', 'rate limit'] },
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
      { href: '/settings/user/memory', label: 'Memory', keywords: ['memory', 'mem0', 'recall', 'forget', 'embeddings', 'history', 'identity', 'preference', 'harness'], advanced: true },
      { href: '/settings/agent', label: 'AI backend', keywords: ['agent backend', 'claude', 'omp', 'meridian', 'models', 'roles', 'command'], advanced: true },
      { href: '/settings/omp', label: 'Oh-My-Pi (omp)', keywords: ['omp', 'oh my pi', 'web search', 'tavily', 'perplexity', 'brave', 'jina', 'kimi', 'exa', 'kagi', 'searxng', 'parallel', 'synthetic', 'hindsight', 'memory', 'thinking', 'compaction'], advanced: true },
      { href: '/settings/omp-integration', label: 'OMP integration', keywords: ['omp', 'engineer collaborator', 'omp-su', 'wrapper', 'mcp', 'integration'], advanced: true },
      { href: '/settings/meridian', label: 'Meridian', keywords: ['meridian', 'telemetry', 'profiles', 'iframe'], advanced: true },
      { href: '/settings/plugin-runtime', label: 'Plugin runtime', keywords: ['plugin', 'runtime', 'hooks', 'load errors', 'cache'], advanced: true },
      { href: '/settings/backups', label: 'Backups', keywords: ['backup', 'backups', 'kopia', 'snapshot', 'restore', 'retention', 'dedup'], advanced: true },
      { href: '/settings/prompt-studio', label: 'Prompt Studio', keywords: ['prompt', 'studio', 'playbook', 'system prompt', 'psu', 'agent prompt', 'overlay', 'project guide', 'preview', 'collaborator'], advanced: true },
    ],
  },
];

const SETTINGS_LINKS = SETTINGS_GROUPS.flatMap((group) => group.links);

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [wizardProgress, setWizardProgress] = useState<{
    finishedAt: string | null;
    completed: number;
    total: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as {
          finished_at?: string;
          step_status?: Record<string, 'completed' | 'dismissed'>;
        };
        if (cancelled) return;
        const TOTAL = 12;
        const completed = Object.values(j.step_status ?? {}).filter(
          (s) => s === 'completed' || s === 'dismissed',
        ).length;
        setWizardProgress({
          finishedAt: j.finished_at ?? null,
          completed: Math.min(completed, TOTAL),
          total: TOTAL,
        });
      } catch { /* leave null */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const publishingEnabled = useFlag(FLAGS.CLOUDFLARE_PUBLISH);
  const testingEnabled = useFlag(FLAGS.TESTING);
  const promptStudioEnabled = useFlag(FLAGS.PROMPT_STUDIO);
  const autonomySettingsEnabled = useFlag(FLAGS.QUEEN_AUTONOMY_SETTINGS);

  const flagEnabled: Record<FlagKey, boolean> = {
    [FLAGS.CLOUDFLARE_PUBLISH]: publishingEnabled,
    [FLAGS.TESTING]: testingEnabled,
    [FLAGS.PROMPT_STUDIO]: promptStudioEnabled,
    [FLAGS.QUEEN_AUTONOMY_SETTINGS]: autonomySettingsEnabled,
    [FLAGS.HARNESS_PHASES]: true,
  };

  const linkAllowed = (href: string): boolean => {
    const flag = SETTINGS_PATH_FLAGS[href];
    return flag ? flagEnabled[flag] : true;
  };

  const filteredGroups = SETTINGS_GROUPS
    .map((group) => ({ ...group, links: group.links.filter((l) => linkAllowed(l.href)) }))
    .filter((group) => group.links.length > 0);

  const filteredLinks = filteredGroups.flatMap((g) => g.links);

  // Sort by href length desc so the most-specific match wins (e.g.
  // `/settings/user/memory` beats `/settings/user` on the memory page).
  const activeLink = [...filteredLinks]
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => pathname === link.href || pathname.startsWith(`${link.href}/`))
    ?? filteredLinks[0];
  const normalizedQuery = query.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return filteredGroups;
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    return filteredGroups
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
                  const active = link.href === activeLink.href;
                  return (
                    <RouteLink
                      key={link.href}
                      href={link.href}
                      className="pc-settings-nav-link"
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="pc-settings-nav-link-label">{link.label}</span>
                      {link.advanced && <span className="pc-settings-nav-chip">Advanced</span>}
                      {link.href === '/settings/setup-wizard' && wizardProgress && (
                        <span
                          className="pc-settings-nav-chip pc-settings-nav-chip--progress"
                          data-finished={wizardProgress.finishedAt ? 'true' : 'false'}
                        >
                          {wizardProgress.finishedAt
                            ? '✓'
                            : `${wizardProgress.completed}/${wizardProgress.total}`}
                        </span>
                      )}
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
