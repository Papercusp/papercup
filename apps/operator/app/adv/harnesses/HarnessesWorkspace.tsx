'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { parseAsString, useQueryState } from 'nuqs';
import HarnessTopBar from './HarnessTopBar';
import HarnessesDock from './HarnessesDock';
import HarnessWelcomeEmptyState from './HarnessWelcomeEmptyState';
import { CreateHarnessPicker } from '../../harness/CreateHarnessPicker';
import './adv-dock.css';

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
 *
 * The "Create new harness" button lives in this view (formerly only
 * reachable via the retired /harness route). Picker success can
 * optionally chain into ShareWizard via the picker's own follow-up.
 */
export default function HarnessesWorkspace() {
  const [slug, setSlug] = useQueryState('slug', parseAsString.withDefault(''));
  const [projects, setProjects] = useState<AdvProjectEntry[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refreshProjects = useCallback(async () => {
    try {
      const r = await fetch('/api/harness/projects/lite');
      if (!r.ok) throw new Error(`projects/lite ${r.status}`);
      const j = (await r.json()) as { projects: AdvProjectEntry[] };
      setProjects(j.projects);
      setProjectsError(null);
    } catch (e) {
      setProjectsError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const handleCreated = useCallback(
    (newSlug: string) => {
      void refreshProjects();
      void setSlug(newSlug);
    },
    [refreshProjects, setSlug],
  );

  return (
    <div className="pc-adv-harnesses pc-adv-dock">
      <HarnessTopBar slug={slug} />
      <div className="pc-adv-harnesses__dock">
        {slug ? (
          <>
            <HarnessesDock slug={slug} />
            {/* No-work-yet onboarding welcome (spec-md-ui-deprecation-cleanup
                P-005 / D-003) — overlays the dock until the harness has a
                started plan or an eligible feature, or is dismissed. */}
            <HarnessWelcomeEmptyState slug={slug} />
          </>
        ) : (
          <div className="pc-adv-harnesses__empty">
            {projectsError ? (
              <>Failed to load harnesses: {projectsError}</>
            ) : projects.length === 0 ? (
              <>
                <div>No harnesses yet.</div>
                <button
                  type="button"
                  className="pc-adv-harnesses__create-cta"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus size={14} aria-hidden /> Create new harness
                </button>
              </>
            ) : (
              <>
                <div>Pick a harness from the selector above.</div>
                <button
                  type="button"
                  className="pc-adv-harnesses__create-cta"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus size={14} aria-hidden /> Create new harness
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {slug && (
        <button
          type="button"
          className="pc-adv-harnesses__create-fab"
          title="Create a new harness"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} aria-hidden /> New harness
        </button>
      )}

      <CreateHarnessPicker
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      <style>{`
        .pc-adv-harnesses {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          position: relative;
        }
        .pc-adv-harnesses__dock {
          flex: 1;
          min-height: 0;
          position: relative;
        }
        .pc-adv-harnesses__empty {
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          padding: 24px;
          color: rgba(220, 214, 248, 0.6);
          font-size: 13px;
          text-align: center;
        }
        .pc-adv-harnesses__create-cta {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 80%);
          color: #e7f7ff;
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .pc-adv-harnesses__create-cta:hover {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 65%);
        }
        .pc-adv-harnesses__create-fab {
          position: absolute;
          bottom: 18px;
          right: 18px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 70%);
          color: #e7f7ff;
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.02em;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.32);
          z-index: 5;
        }
        .pc-adv-harnesses__create-fab:hover {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
        }
        /* Blue-frost dock theme now lives in the shared ./adv-dock.css
           (scoped to .pc-adv-dock — applied here and on the Git dock). */
      `}</style>
    </div>
  );
}
