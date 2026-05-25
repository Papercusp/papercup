'use client';

import { useEffect, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import HarnessTopBar from './HarnessTopBar';
import HarnessesDock from './HarnessesDock';

export interface AdvProjectEntry {
  slug: string;
  path: string;
  hasState: boolean;
  hasSpec: boolean;
}

/**
 * /adv/harnesses — replacement for the legacy /harness OPS surface.
 *
 * Single-harness scope: top bar drives the selected slug, and the
 * dockview below shows Features + Issues for that same slug. The
 * selected slug lives in `?slug=` so the page is deep-linkable.
 */
export default function HarnessesWorkspace() {
  const [slug, setSlug] = useQueryState('slug', parseAsString.withDefault(''));
  const [projects, setProjects] = useState<AdvProjectEntry[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/harness/projects/lite')
      .then((r) => {
        if (!r.ok) throw new Error(`projects/lite ${r.status}`);
        return r.json() as Promise<{ projects: AdvProjectEntry[] }>;
      })
      .then((j) => {
        if (cancelled) return;
        setProjects(j.projects);
        if (!slug && j.projects.length > 0) {
          // Default to the last-active project from legacy localStorage
          // so /adv/harnesses lands on the same project /harness would.
          let initial = j.projects[0].slug;
          try {
            const saved = window.localStorage.getItem('harness.activeProject');
            if (saved && j.projects.some((p) => p.slug === saved)) initial = saved;
          } catch {
            /* localStorage unavailable */
          }
          void setSlug(initial);
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setProjectsError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // intentionally NOT depending on `slug` — we only want the auto-pick
    // logic to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!slug) return;
    try {
      window.localStorage.setItem('harness.activeProject', slug);
    } catch {
      /* ignore */
    }
  }, [slug]);

  return (
    <div className="pc-adv-harnesses">
      <HarnessTopBar
        slug={slug || ''}
        projects={projects}
        projectsError={projectsError}
        onSlugChange={(next) => void setSlug(next)}
      />
      <div className="pc-adv-harnesses__dock">
        {slug ? (
          <HarnessesDock slug={slug} />
        ) : (
          <div className="pc-adv-harnesses__empty">
            {projectsError
              ? `Failed to load harnesses: ${projectsError}`
              : projects.length === 0
                ? 'No harnesses yet. Create one in /harness to populate this view.'
                : 'Pick a harness from the selector above.'}
          </div>
        )}
      </div>
      <style>{`
        .pc-adv-harnesses {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        .pc-adv-harnesses__dock {
          flex: 1;
          min-height: 0;
          position: relative;
        }
        .pc-adv-harnesses__empty {
          height: 100%;
          display: grid;
          place-items: center;
          padding: 24px;
          color: rgba(220, 214, 248, 0.6);
          font-size: 13px;
          text-align: center;
        }
      `}</style>
    </div>
  );
}
