import { useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';

const ADV_TAB_IDS = ['brainstorm', 'prs', 'insights', 'config', 'settings', 'docs', 'plans', 'sessions'] as const;
export type AdvTabId = (typeof ADV_TAB_IDS)[number];

/**
 * /adv shell — TSR mirror of apps/operator/app/adv/_components/AdvShell.tsx.
 *
 * The Vite operator is the live UI (the legacy Next operator at
 * apps/operator/app/* is parallel/transitional); /adv has to live
 * here too or the ADV navbar button serves stale tabs.
 */
export const ADV_TABS: ReadonlyArray<{ id: AdvTabId; label: string }> = [
  { id: 'brainstorm', label: 'Brainstorm' },
  { id: 'prs', label: 'PRs' },
  { id: 'insights', label: 'Insights' },
  { id: 'config', label: 'Config' },
  { id: 'settings', label: 'Settings' },
  { id: 'docs', label: 'Docs' },
  { id: 'plans', label: 'Plans' },
  { id: 'sessions', label: 'Sessions' },
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
        <div className="pc-advshell__controls">
          <label className="pc-advshell__selector">
            <span>Harness</span>
            <select
              value={activeSlug ?? ''}
              onChange={(event) => {
                const next = event.currentTarget.value || null;
                void setActiveSlug(next);
                if (next && typeof window !== 'undefined') {
                  window.localStorage.setItem('harness.activeProject', next);
                }
              }}
              disabled={projects.length === 0}
            >
              {projects.length === 0 ? (
                <option value="">{projectLoadError ? 'Failed to load harnesses' : 'Loading harnesses…'}</option>
              ) : (
                projects.map((project) => (
                  <option key={project.slug} value={project.slug}>
                    {project.slug}
                  </option>
                ))
              )}
            </select>
          </label>
          <Tabs.Root value={activeTab} onValueChange={(value) => void setActiveTab(value as AdvTabId)} className="pc-advshell__tabs">
            <Tabs.List className="pc-advshell__tablist" aria-label="Adv sections">
              {ADV_TABS.map((t) => (
                <Tabs.Trigger key={t.id} value={t.id} className="pc-advshell__tab">
                  {t.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs.Root>
        </div>
        <span className="pc-advshell__spacer" />
      </header>
      <div className="pc-advshell__body">{children}</div>
      <style>{`
        .pc-advshell {
          display: flex;
          flex-direction: column;
          min-height: calc(100vh - 56px);
          background:
            radial-gradient(circle at top left, rgba(167, 139, 250, 0.07), transparent 28%),
            linear-gradient(180deg, rgba(8, 10, 22, 0.99), rgba(5, 8, 18, 1));
        }
        .pc-advshell__header {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          padding: 14px 18px 12px;
          border-bottom: 1px solid rgba(167, 139, 250, 0.16);
          background:
            linear-gradient(180deg, rgba(11, 13, 28, 0.98), rgba(8, 11, 24, 0.98));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.02);
        }
        .pc-advshell__copy { display: grid; gap: 4px; min-width: 0; }
        .pc-advshell__kicker {
          color: rgba(199, 188, 252, 0.66);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.11em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-advshell__header h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 760;
          line-height: 1;
          letter-spacing: -0.02em;
          color: #f7f5ff;
        }
        .pc-advshell__controls {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
          min-width: 0;
        }
        .pc-advshell__selector {
          display: grid;
          gap: 5px;
          min-width: 190px;
          color: rgba(199, 188, 252, 0.7);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.09em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-advshell__selector select {
          min-height: 34px;
          min-width: 0;
          border: 1px solid rgba(167, 139, 250, 0.24);
          border-radius: 10px;
          background: rgba(8, 10, 22, 0.92);
          color: #f7f5ff;
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0;
          padding: 0 34px 0 11px;
          text-transform: none;
        }
        .pc-advshell__selector select:disabled {
          color: rgba(220, 214, 248, 0.46);
        }
        .pc-advshell__tabs { align-self: stretch; display: flex; align-items: flex-end; }
        .pc-advshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          padding: 0 0 1px;
        .pc-advshell__tab {
          display: inline-flex;
          align-items: center;
          min-height: 34px;
          padding: 0 12px;
          border: 1px solid rgba(167, 139, 250, 0.16);
          border-bottom-color: rgba(167, 139, 250, 0.08);
          border-radius: 10px 10px 0 0;
          background: rgba(255, 255, 255, 0.02);
          color: rgba(220, 214, 248, 0.74);
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0.02em;
          text-decoration: none !important;
          transition: background-color 120ms, border-color 120ms, color 120ms;
        }
        .pc-advshell__tab:hover {
          color: #f7f5ff;
          background: rgba(20, 18, 38, 0.96);
          border-color: rgba(167, 139, 250, 0.32);
        }
        .pc-advshell__tab[data-state='active'] {
          color: #f7f5ff;
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.5);
          border-bottom-color: transparent;
        }
        .pc-advshell__spacer { flex: 1; }
        .pc-advshell__body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      `}</style>
    </div>
  );
}
