'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { parseAsString, useQueryState } from 'nuqs';
import HarnessTopBar from './HarnessTopBar';
import HarnessesDock from './HarnessesDock';
import { CreateHarnessPicker } from '../../harness/CreateHarnessPicker';

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
    <div className="pc-adv-harnesses">
      <HarnessTopBar slug={slug} projects={projects} />
      <div className="pc-adv-harnesses__dock">
        {slug ? (
          <HarnessesDock slug={slug} />
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

        /* ── Blue-frost dock theme ──────────────────────────────────────
           dockview ships a flat grey dark theme (#1e1e1e). Re-skin the
           /adv harness dock to the Papercusp blue-frost glass — var(--frost)
           over navy with sky accents — so panel headers and empty panels
           match the rest of the app. Scoped to .pc-adv-harnesses so the
           legacy /harness dock is untouched. Flat colours go through
           dockview's --dv-* vars; the frosted surfaces (gradients can't be
           a var colour) are overridden on the element. */
        .pc-adv-harnesses .dockview-theme-dark {
          --dv-group-view-background-color: rgba(7, 16, 29, 0.92);
          --dv-tabs-and-actions-container-background-color: transparent;
          --dv-activegroup-visiblepanel-tab-background-color: transparent;
          --dv-inactivegroup-visiblepanel-tab-background-color: transparent;
          --dv-activegroup-hiddenpanel-tab-background-color: transparent;
          --dv-inactivegroup-hiddenpanel-tab-background-color: transparent;
          --dv-activegroup-visiblepanel-tab-color: var(--fg);
          --dv-inactivegroup-visiblepanel-tab-color: var(--fg-mute);
          --dv-activegroup-hiddenpanel-tab-color: var(--fg-mute);
          --dv-inactivegroup-hiddenpanel-tab-color: var(--fg-mute);
          --dv-tab-divider-color: rgb(from var(--sky-300) r g b / 0.16);
          --dv-separator-border: rgb(from var(--sky-300) r g b / 0.14);
        }

        /* Empty panels + group surface + the empty-group watermark. */
        .pc-adv-harnesses .dockview-theme-dark .dv-groupview,
        .pc-adv-harnesses .dockview-theme-dark .dv-watermark,
        .pc-adv-harnesses__empty {
          background:
            radial-gradient(ellipse at 50% -10%, rgba(215, 243, 255, 0.06), transparent 60%),
            var(--frost),
            rgba(9, 19, 34, 0.55) !important;
        }

        /* Panel headers (every panel) — frosted glass strip + sky hairline. */
        .pc-adv-harnesses .dockview-theme-dark .dv-tabs-and-actions-container {
          background:
            radial-gradient(ellipse at 50% 0%, rgba(215, 243, 255, 0.085), transparent 68%),
            var(--frost),
            rgba(9, 19, 34, 0.62) !important;
          border-bottom: 1px solid rgb(from var(--sky-300) r g b / 0.16);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.06),
            inset 0 -1px 0 rgb(from var(--sky-300) r g b / 0.06);
        }

        /* Tabs ride transparent over the frost strip; active tab gets a
           sky wash + underline, hover a fainter wash. */
        .pc-adv-harnesses .dockview-theme-dark .dv-tab {
          transition: background-color 120ms ease, color 120ms ease;
        }
        .pc-adv-harnesses .dockview-theme-dark .dv-tab:hover {
          background: color-mix(in oklab, var(--accent), transparent 90%);
          color: var(--fg);
        }
        .pc-adv-harnesses .dockview-theme-dark .dv-tab.dv-active-tab {
          background: color-mix(in oklab, var(--accent), transparent 86%);
          box-shadow: inset 0 -2px 0 var(--accent);
          color: var(--fg);
        }
      `}</style>
    </div>
  );
}
