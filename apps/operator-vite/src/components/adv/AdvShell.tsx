import { useEffect, useState, type ComponentType, type CSSProperties } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import {
  BookOpen,
  Boxes,
  GitBranch,
  Lightbulb,
  ListChecks,
  Settings,
  SlidersHorizontal,
  Terminal,
  TrendingUp,
} from 'lucide-react';
import { Select } from '@/app/harness/Select';
import AdvNowRunning from './AdvNowRunning';

const ADV_TAB_IDS = ['harnesses', 'brainstorm', 'prs', 'insights', 'config', 'settings', 'docs', 'git', 'plans', 'sessions'] as const;
export type AdvTabId = (typeof ADV_TAB_IDS)[number];

/**
 * /adv shell — TSR mirror of apps/operator/app/adv/_components/AdvShell.tsx.
 *
 * The Vite operator is the live UI (the legacy Next operator at
 * apps/operator/app/* is parallel/transitional); /adv has to live
 * here too or the ADV navbar button serves stale tabs.
 */
export const ADV_TABS: ReadonlyArray<{
  id: Exclude<AdvTabId, 'prs'>;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  accent: string;
  accentRgb: string;
}> = [
  { id: 'harnesses', label: 'Harnesses', icon: Boxes, accent: '#a78bfa', accentRgb: '167, 139, 250' },
  { id: 'brainstorm', label: 'Brainstorm', icon: Lightbulb, accent: '#38bdf8', accentRgb: '56, 189, 248' },
  { id: 'plans', label: 'Plans', icon: ListChecks, accent: '#f59e0b', accentRgb: '245, 158, 11' },
  { id: 'sessions', label: 'Sessions', icon: Terminal, accent: '#f472b6', accentRgb: '244, 114, 182' },
  { id: 'git', label: 'Git', icon: GitBranch, accent: '#22c55e', accentRgb: '34, 197, 94' },
  { id: 'docs', label: 'Docs', icon: BookOpen, accent: '#60a5fa', accentRgb: '96, 165, 250' },
  { id: 'insights', label: 'Insights', icon: TrendingUp, accent: '#14b8a6', accentRgb: '20, 184, 166' },
  { id: 'config', label: 'Config', icon: SlidersHorizontal, accent: '#e879f9', accentRgb: '232, 121, 249' },
  { id: 'settings', label: 'Settings', icon: Settings, accent: '#f97316', accentRgb: '249, 115, 22' },
] as const;

type HarnessProjectLite = {
  slug: string;
  path?: string;
  hasState?: boolean;
  hasSpec?: boolean;
};

export default function AdvShell({
  title = 'Advanced',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const [activeTab, setActiveTab] = useQueryState(
    'tab',
    parseAsStringEnum<AdvTabId>([...ADV_TAB_IDS]).withDefault('brainstorm'),
  );
  const [activeSlug, setActiveSlug] = useQueryState('slug', parseAsString);
  const [projects, setProjects] = useState<HarnessProjectLite[]>([]);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/harness/projects/lite', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        const nextProjects = Array.isArray(d?.projects) ? d.projects : [];
        setProjects(nextProjects);
        setProjectLoadError(null);
        if (!nextProjects.length) return;
        if (activeSlug && nextProjects.some((p: HarnessProjectLite) => p.slug === activeSlug)) return;
        const saved = typeof window !== 'undefined' ? window.localStorage.getItem('harness.activeProject') : null;
        const savedProject = saved ? nextProjects.find((p: HarnessProjectLite) => p.slug === saved) : null;
        void setActiveSlug(savedProject?.slug ?? nextProjects[0]!.slug);
      })
      .catch((e) => {
        if (!cancelled) setProjectLoadError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSlug, setActiveSlug]);

  return (
    <div className="pc-advshell">
      <header className="pc-advshell__header">
        <div className="pc-advshell__copy">
          <span className="pc-advshell__kicker">Advanced orchestration</span>
          <h1>{title}</h1>
        </div>
        <label className="pc-advshell__selector">
          <span>Harness</span>
          <Select
            value={activeSlug ?? ''}
            onChange={(next) => {
              if (next === '__loading') return;
              void setActiveSlug(next);
              if (next && typeof window !== 'undefined') {
                window.localStorage.setItem('harness.activeProject', next);
              }
            }}
            disabled={projects.length === 0}
            ariaLabel="Select harness"
            placeholder={projectLoadError ? 'Failed to load harnesses' : 'Select harness'}
            options={
              projects.length === 0
                ? [{ value: '__loading', label: projectLoadError ? 'Failed to load harnesses' : 'Loading harnesses…', disabled: true }]
                : projects.map((project) => ({ value: project.slug, label: project.slug }))
            }
            triggerClassName="pc-advshell__select-trigger"
          />
        </label>
        <AdvNowRunning slug={activeSlug} />
        <Tabs.Root value={activeTab} onValueChange={(value) => void setActiveTab(value as AdvTabId)} className="pc-advshell__tabs">
          <Tabs.List className="pc-advshell__tablist" aria-label="Adv sections">
            {ADV_TABS.map((t) => {
              const Icon = t.icon;
              return (
                <Tabs.Trigger
                  key={t.id}
                  value={t.id}
                  className={`pc-advshell__tab pc-advshell__tab--${t.id}`}
                  style={{
                    '--h-main-tab-accent': t.accent,
                    '--h-main-tab-accent-rgb': t.accentRgb,
                  } as CSSProperties}
                >
                  <Icon size={13} aria-hidden />
                  {t.label.toLowerCase()}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        </Tabs.Root>
      </header>
      <div className="pc-advshell__body">{children}</div>
      <style>{`
        .pc-advshell {
          display: flex;
          flex-direction: column;
          min-height: calc(100vh - 56px);
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--accent, #38bdf8), transparent 91%), transparent 30%),
            linear-gradient(180deg, var(--bg, #07101d), #04111b);
        }
        .pc-advshell__header {
          display: flex;
          align-items: flex-end;
          gap: 14px;
          min-width: 0;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.15));
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.025);
        }
        .pc-advshell__copy { display: grid; gap: 4px; min-width: 0; }
        .pc-advshell__kicker {
          color: color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 26%);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.11em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-advshell__header h1 {
          margin: 0;
          font-size: 22px;
          font-weight: 760;
          line-height: 1;
          letter-spacing: -0.02em;
          color: var(--fg, #e7f7ff);
        }
        .pc-advshell__selector {
          display: grid;
          gap: 5px;
          min-width: 190px;
          color: var(--fg-dim, #b9d4e8);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.09em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-advshell__select-trigger {
          display: inline-flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 34px;
          min-width: 190px;
          border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
          border-radius: 10px;
          background: var(--bg-popover, #0d1829);
          color: var(--fg, #e7f7ff);
          font-size: 12px;
          font-weight: 650;
          padding: 0 11px;
          cursor: pointer;
          outline: none;
        }
        .pc-advshell__select-trigger[data-disabled] {
          color: var(--fg-mute, #7f9bb4);
          cursor: default;
        }
        .pc-advshell__now-running {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          max-width: 540px;
          padding-bottom: 2px;
        }
        .pc-advshell__action {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border-radius: 6px;
          border: 1px solid transparent;
          cursor: pointer;
          flex-shrink: 0;
        }
        .pc-advshell__action:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .pc-advshell__action--start {
          background: rgba(34, 197, 94, 0.16);
          color: #86efac;
          border-color: rgba(34, 197, 94, 0.38);
        }
        .pc-advshell__action--start:hover:not(:disabled) {
          background: rgba(34, 197, 94, 0.26);
        }
        .pc-advshell__action--stop {
          background: rgba(239, 68, 68, 0.12);
          color: #fca5a5;
          border-color: rgba(239, 68, 68, 0.34);
        }
        .pc-advshell__action--stop:hover {
          background: rgba(239, 68, 68, 0.22);
        }
        .pc-advshell__pills {
          display: flex;
          gap: 4px;
          min-width: 0;
          overflow: hidden;
        }
        .pc-advshell__pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          font-size: 11px;
          color: rgba(220, 214, 248, 0.86);
          background: rgba(20, 18, 38, 0.7);
          border: 1px solid rgba(167, 139, 250, 0.28);
          border-radius: 999px;
          cursor: default;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 200px;
        }
        .pc-advshell__pill:hover {
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.5);
        }
        .pc-advshell__pill-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #86efac;
          box-shadow: 0 0 8px rgba(134, 239, 172, 0.6);
          flex-shrink: 0;
          animation: pc-advshell-pulse 1.6s ease-in-out infinite;
        }
        @keyframes pc-advshell-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .pc-advshell__idle {
          font-size: 11px;
          font-style: italic;
          color: rgba(220, 214, 248, 0.5);
          white-space: nowrap;
        }
        .pc-advshell__tabs { flex: 1; min-width: 0; display: flex; align-items: flex-end; }
        .pc-advshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          min-width: 0;
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          overscroll-behavior-x: contain;
          scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
          padding: 0;
          mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent);
        }
        .pc-advshell__tablist::-webkit-scrollbar {
          display: none;
        }
        .pc-advshell__tab {
          position: relative;
          flex: 0 0 auto;
          scroll-snap-align: start;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 34px;
          margin-bottom: -1px;
          padding: 9px 14px 10px;
          border: 1px solid transparent;
          border-bottom: 1px solid transparent;
          border-radius: 10px 10px 0 0;
          background:
            radial-gradient(circle at 18% 0%, rgba(var(--h-main-tab-accent-rgb), 0.12), transparent 72%),
            linear-gradient(180deg, rgba(var(--h-main-tab-accent-rgb), 0.080), rgba(3, 10, 20, 0.98));
          border-color: rgba(var(--h-main-tab-accent-rgb), 0.28);
          color: color-mix(in oklab, var(--fg-dim, #b9d4e8), var(--h-main-tab-accent) 18%);
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          cursor: pointer;
          transition: color var(--dur-fast, 120ms) var(--ease-out, ease), border-color var(--dur-fast, 120ms) var(--ease-out, ease), background-color var(--dur-fast, 120ms) var(--ease-out, ease);
        }
        .pc-advshell__tab:hover {
          color: var(--fg, #e7f7ff);
        }
        .pc-advshell__tab:focus-visible {
          color: var(--fg, #e7f7ff);
          outline: 1px solid color-mix(in oklab, var(--accent, #38bdf8), white 16%);
          outline-offset: -2px;
        }
        .pc-advshell__tab[aria-selected='true'],
        .pc-advshell__tab[data-state='active'] {
          color: var(--fg, #e7f7ff);
          background: rgba(var(--h-main-tab-accent-rgb), 0.22);
          border-color: rgba(var(--h-main-tab-accent-rgb), 0.68);
          border-bottom-color: color-mix(in oklab, var(--bg-2, rgba(255, 255, 255, 0.045)), white 3%);
          box-shadow: 0 -8px 22px rgba(0, 0, 0, 0.16);
        }
        .pc-advshell__tab[aria-selected='true']::after,
        .pc-advshell__tab[data-state='active']::after {
          content: "";
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 2px;
          height: 2px;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--h-main-tab-accent), color-mix(in oklab, var(--h-main-tab-accent), white 28%));
          box-shadow: 0 0 14px color-mix(in oklab, var(--h-main-tab-accent), transparent 54%);
        }
        .pc-advshell__body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      `}</style>
    </div>
  );
}
