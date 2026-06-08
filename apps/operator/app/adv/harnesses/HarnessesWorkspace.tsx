'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { HARNESS_SCOPE_MODES, type HarnessScopeMode } from '@papercusp/operator-core/lib/harness/scope';
import { useLexicon } from '@/lib/useLexicon';
import HarnessTopBar from './HarnessTopBar';
import HarnessesDock from './HarnessesDock';
import HarnessWelcomeEmptyState from './HarnessWelcomeEmptyState';
import HiveMemberRail from './HiveMemberRail';
import HiveHeaderStrip from './HiveHeaderStrip';
import HiveWorkspaceCards from './HiveWorkspaceCards';
import { CreateHarnessPicker } from '../../harness/CreateHarnessPicker';
import { hiveMembers, resolveFocusedMember, isHarnessParamStale } from './harness-axis';
import { groupByHive, type HiveGroup } from './harness-hive-groups';
import './adv-dock.css';

export interface AdvProjectEntry {
  slug: string;
  path: string;
  hasState: boolean;
  hasSpec: boolean;
  // projects/lite also carries the hive-grouping fields (P-012): parent_slug
  // + harness_kind drive the member axis, is_shared the rail badge. Optional
  // so older payloads / fixtures stay valid.
  parent_slug?: string | null;
  harness_kind?: string | null;
  is_shared?: boolean;
}

/**
 * /adv/harnesses — the hive-aware Harnesses workspace (replaces the legacy
 * /harness OPS surface).
 *
 * Two URL axes (harnesses-tab-hive-model-2026-06-07 D-001): `?slug=` is the
 * HIVE / root scope (owned by the shell selector); `?harness=` is the MEMBER
 * focus within that hive (owned here). `?scope=all` (the shell's "All Pots")
 * switches to the hive-grouped workspace overview (D-003).
 *
 * The member rail (P-002) is the in-tab place to select among a hive's
 * member harnesses — the affordance the tab was missing. The "Create new
 * harness" button lives here (formerly only reachable via the retired
 * /harness route).
 */
export default function HarnessesWorkspace() {
  const t = useLexicon();
  // `?slug=` is the HIVE / root scope (owned by the shell selector). The new
  // `?harness=` axis is the MEMBER focus within that hive — which member's
  // dock is open. Nullable: unset means "use the hive's default member"
  // (D-001). Only this tab reads `?harness=`, so `?slug=` semantics stay
  // untouched everywhere else (P-001).
  const [slug, setSlug] = useQueryState('slug', parseAsString.withDefault(''));
  const [harness, setHarness] = useQueryState('harness', parseAsString);
  // `?scope=` is the shell's orthogonal scope axis; `all` is "All Pots". We
  // read it here to swap the single-hive dock for the hive-grouped workspace
  // cards (P-003 / D-003), and write it on drill-in to exit all-mode.
  const [scopeMode, setScopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault('expanded'),
  );
  const [projects, setProjects] = useState<AdvProjectEntry[]>([]);
  // P-021: the registry now groups hive→members SERVER-side; prefer that field so
  // the all-mode cards stop re-inferring the grouping client-side. Falls back to
  // the shared `groupByHive` (same module) for an older payload without `hives`.
  const [serverHives, setServerHives] = useState<HiveGroup<AdvProjectEntry>[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refreshProjects = useCallback(async () => {
    try {
      const r = await fetch('/api/harness/projects/lite');
      if (!r.ok) throw new Error(`projects/lite ${r.status}`);
      const j = (await r.json()) as { projects: AdvProjectEntry[]; hives?: HiveGroup<AdvProjectEntry>[] };
      setProjects(j.projects);
      setServerHives(j.hives ?? null);
      setProjectsError(null);
    } catch (e) {
      setProjectsError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const allMode = scopeMode === 'all';

  // The hive's members (root first, then parent_slug children) and the
  // focused member the dock should render. Pure logic in ./harness-axis so
  // it's unit-tested + shared with the member rail (P-002).
  const members = useMemo(() => hiveMembers(projects, slug || null), [projects, slug]);
  const focusedMember = useMemo(
    () => resolveFocusedMember({ members, urlHarness: harness }),
    [members, harness],
  );
  // The harness the dock + meta line target: the focused member, falling back
  // to the hive root while projects/lite is still loading (members empty) so
  // the common solo case mounts instantly with no flash.
  const dockSlug = focusedMember ?? (slug || null);

  // Zero-new-poller liveness hint for the rail (P-002): `hasState` from the
  // already-fetched projects/lite payload (the harness has been set up).
  const livenessBySlug = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.slug, !!p.hasState])),
    [projects],
  );

  // All-mode (P-003): every hive in the workspace, grouped by root subtree.
  // Prefer the SERVER grouping (P-021); fall back to the shared client compute.
  const groups = useMemo(() => serverHives ?? groupByHive(projects), [serverHives, projects]);

  // Drop a stale `?harness=` when the shell selector switches `?slug=` to a
  // different hive (the value no longer names a member). Guarded inside
  // isHarnessParamStale on members-loaded so a valid deep link isn't cleared
  // before projects/lite arrives.
  useEffect(() => {
    if (isHarnessParamStale(members, harness)) void setHarness(null);
  }, [members, harness, setHarness]);

  const handleCreated = useCallback(
    (newSlug: string, opts?: { hive?: string }) => {
      void refreshProjects();
      if (opts?.hive && opts.hive === slug) {
        // Added INTO the current hive (P-011): land the new member focused in the
        // rail — keep `?slug=` on the hive, set `?harness=` to the new member.
        void setHarness(newSlug);
      } else {
        // A new hive / standalone harness becomes the focused scope.
        void setSlug(newSlug);
        void setHarness(null);
      }
    },
    [refreshProjects, setSlug, setHarness, slug],
  );

  // Drill from an all-mode card into one member (D-003). Writes are SEQUENTIAL
  // — a same-tick scope+slug+harness triple collides in the nuqs adapter (last
  // write wins), the exact pattern AdvShell documents for its own onChange. We
  // exit all-mode (scope=expanded), set the hive, then the member (null when
  // it's the root — the default focus, keeping URLs clean).
  const drillIntoMember = useCallback(
    async (hiveSlug: string, memberSlug: string) => {
      await setScopeMode('expanded');
      await setSlug(hiveSlug);
      await setHarness(memberSlug === hiveSlug ? null : memberSlug);
    },
    [setScopeMode, setSlug, setHarness],
  );

  const hiveLabel = t('pot');
  const hivesLabel = t('pot', { plural: true });

  // The hive header strip (P-022) — the selected hive's face. Shown for a real
  // multi-member hive or a formal kind:'hive' home; a solo non-hive harness
  // renders no header (zero regression, same gate the member rail uses).
  const hiveRoot = useMemo(() => projects.find((p) => p.slug === slug) ?? null, [projects, slug]);
  const showHiveHeader = !!slug && (members.length > 1 || hiveRoot?.harness_kind === 'hive');
  const headerMembers = useMemo(
    () => members.map((m) => ({ slug: m.slug, hasState: livenessBySlug[m.slug] ?? false })),
    [members, livenessBySlug],
  );

  return (
    <div className="pc-adv-harnesses pc-adv-dock">
      {allMode ? (
        // All-mode (D-003): the hive-grouped workspace overview replaces the
        // stale single-harness dock the tab used to keep showing.
        <HiveWorkspaceCards
          groups={groups}
          onDrill={(hive, member) => void drillIntoMember(hive, member)}
          onCreate={() => setCreateOpen(true)}
        />
      ) : (
        <>
          {/* The hive header strip (P-022) — the selected hive's face above the
              member surface. Gated so a solo non-hive harness is byte-identical. */}
          {showHiveHeader && (
            <HiveHeaderStrip
              hiveSlug={slug}
              hiveKind={hiveRoot?.harness_kind ?? null}
              isShared={hiveRoot?.is_shared}
              members={headerMembers}
            />
          )}
          {/* The dock, meta line, and welcome all key off the FOCUSED MEMBER
              (`?harness=` resolved against the hive's members), not the raw hive
              `?slug=` — so a hive with several member harnesses shows the picked
              one. Solo harnesses resolve dockSlug === slug (zero regression). */}
          <HarnessTopBar slug={dockSlug ?? ''} />
          <div className="pc-adv-harnesses__body">
            {/* The member rail (P-002) — the in-tab harness selector. Renders
                nothing for solo hives (single member → no choice). */}
            <HiveMemberRail
              members={members}
              activeSlug={dockSlug}
              onSelect={(memberSlug) => void setHarness(memberSlug)}
              livenessBySlug={livenessBySlug}
            />
            <div className="pc-adv-harnesses__dock">
              {dockSlug ? (
                <>
                  <HarnessesDock slug={dockSlug} />
                  {/* No-work-yet onboarding welcome (spec-md-ui-deprecation-cleanup
                      P-005 / D-003) — overlays the dock until the harness has a
                      started plan or an eligible feature, or is dismissed. */}
                  <HarnessWelcomeEmptyState slug={dockSlug} />
                </>
              ) : (
                <div className="pc-adv-harnesses__empty">
                  {projectsError ? (
                    <>Failed to load {hivesLabel.toLowerCase()}: {projectsError}</>
                  ) : projects.length === 0 ? (
                    <>
                      <div>No {hivesLabel.toLowerCase()} yet.</div>
                      <button
                        type="button"
                        className="pc-adv-harnesses__create-cta"
                        onClick={() => setCreateOpen(true)}
                      >
                        <Plus size={14} aria-hidden /> Create a {hiveLabel.toLowerCase()}
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Hive-aware empty state (P-004) — replaces the retired
                          single-harness "Pick a harness from the selector above". */}
                      <div>Select a {hiveLabel.toLowerCase()} from the selector above to open it.</div>
                      <button
                        type="button"
                        className="pc-adv-harnesses__create-cta"
                        onClick={() => setCreateOpen(true)}
                      >
                        <Plus size={14} aria-hidden /> Create a {hiveLabel.toLowerCase()}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {!allMode && slug && (
        <button
          type="button"
          className="pc-adv-harnesses__create-fab"
          title={`Add a ${t('harness', { lower: true })} to this ${hiveLabel.toLowerCase()}`}
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} aria-hidden /> New {t('harness', { lower: true })}
        </button>
      )}

      <CreateHarnessPicker
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        hiveScope={slug || null}
        hiveLabel={hiveLabel}
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
        .pc-adv-harnesses__body {
          flex: 1;
          min-height: 0;
          display: flex;
          min-width: 0;
        }
        .pc-adv-harnesses__dock {
          flex: 1;
          min-height: 0;
          min-width: 0;
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
