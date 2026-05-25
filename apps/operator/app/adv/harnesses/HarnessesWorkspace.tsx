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
 * /adv/harnesses — single-harness workspace replacing the legacy /harness
 * OPS surface.
 *
 * Slug comes from `?slug=` which the AdvShell header already owns. We
 * only fetch projects locally for the path-and-progress meta line in the
 * top bar; the selector itself lives in the shell.
 */
export default function HarnessesWorkspace() {
  const [slug] = useQueryState('slug', parseAsString.withDefault(''));
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
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setProjectsError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="pc-adv-harnesses">
      <HarnessTopBar slug={slug} projects={projects} />
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
