import { useEffect, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { HARNESS_SCOPE_MODES, type HarnessScopeMode } from '@papercusp/operator-core/lib/harness/scope';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { Check, Plus, Share2 } from 'lucide-react';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { defaultFetchShareMeta, type HiveShareVisibility } from '@/app/harness/ShareHiveDialog';
import { useWorkspaceLabel } from '@/lib/useWorkspaceLabel';
import { useLexicon } from '@/lib/useLexicon';
import AdvNowRunning from './AdvNowRunning';
import HivesRunningPill from './HivesRunningPill';
import AgentsRunningPill from './AgentsRunningPill';
import DiscordBadge from './DiscordBadge';
import { ALL_HARNESSES_OPTION } from './adv-harness-selection';
import { buildHarnessSelectOptions, type HarnessProjectLite } from './AdvShell';
import './adv-header-pills.css';
import './adv-pot-bar.css';

/**
 * AdvPotBar — the POT cluster: `POT` label · selector · sub-pots toggle · New ·
 * Share/Shared, optionally followed by the status pills (pots running · agents
 * running · the pot's own start/stop + "N plans waiting" bar · Discord).
 *
 * WHY it is a component and not part of AdvShell's header (owner ask 2026-07-27):
 * the cluster used to sit in the "ADVANCED ORCHESTRATION / <title>" bar ABOVE the
 * tab strip, which read as "this scopes everything you see" — but several tabs are
 * workspace-scoped (HUD aggregates every session in the workspace, Calendar every
 * pot's schedule), so a global pot picker over them was confusing. That bar is
 * gone. The cluster now renders as the FIRST ROW INSIDE each tab that is genuinely
 * pot-scoped (POT_BAR_TAB_IDS below), with the status pills on HUD — the owner's
 * chosen home for them.
 *
 * It writes exactly the SAME URL axes the shell used to own, so nothing
 * downstream changed: `?slug=` (the pot), `?scope=` (self | expanded | all),
 * `?harness=` (cleared on a pot pick so a drilled-into member doesn't linger),
 * `?create=` / `?share=` (the two modals AdvShell still mounts from URL state).
 * That is also why there is no prop plumbing and no second source of truth: the
 * URL is the source of truth, `useAdvScope()` is the read side, and this is the
 * write side.
 *
 * The registry read (`harnessProjects.lite`) is the SAME sync query AdvShell and
 * HarnessesWorkspace make with the SAME args, so useSyncQuery serves it from one
 * shared cache entry — mounting this costs a memo, not a fetch, and the selector
 * can never disagree with the shell about what pots exist.
 */

/* WHICH tabs render this row (POT_BAR_TAB_IDS / potBarModeForTab) is deliberately
   NOT in this file — it lives in the pure `adv-pot-bar-tabs.ts` so the route can
   ask without importing the component and its four status children. */

export default function AdvPotBar({ withStatus = false }: { withStatus?: boolean }) {
  const t = useLexicon();
  const [activeSlug, setActiveSlug] = useQueryState('slug', parseAsString);
  // The Harnesses-tab member axis. Cleared (→ null) whenever a pot is picked here,
  // so the Work dock re-scopes to the picked pot instead of staying pinned to a
  // sub-hive the user had drilled into (the stale-?harness bug). The tab owns
  // READING it; this row only clears it.
  const [, setActiveHarness] = useQueryState('harness', parseAsString);
  const [scopeMode, setScopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault('expanded'),
  );
  // The two modals are mounted by AdvShell from URL state; this row only opens them.
  const [, setCreateOpen] = useQueryState('create', parseAsBoolean.withDefault(false));
  const [, setShareOpen] = useQueryState('share', parseAsBoolean.withDefault(false));

  const { data: projectsData, error: projectsError } = useSyncQuery<HarnessProjectLite>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });
  const projects = projectsData ?? [];
  const projectLoadError = projectsError ? String(projectsError.message ?? projectsError) : null;
  const workspaceLabel = useWorkspaceLabel();

  const allMode = scopeMode === 'all';
  const singleSlug = allMode ? null : activeSlug;
  const activeProject = singleSlug ? projects.find((p) => p.slug === singleSlug) : undefined;
  // Sharing happens at the HIVE level (comb-retire-per-harness-sharing-2026-06-11):
  // Share publishes the active hive to the P2P directory. `is_shared` (a legacy
  // per-harness `.papercusp/shared.json`) only surfaces as a passive badge.
  const activeIsHive = activeProject?.harness_kind === 'hive';
  const activeIsShared = !!activeProject?.is_shared;

  // The active HIVE's directory share-state (comb-hive-native-sharing-2026-06-11):
  // a hive is "shared" once its owned directory listing is `public` or `invite`
  // (`private` = withdrawn, null = never published). This rides the discovery
  // registry meta, NOT `is_shared`. A one-shot owner-meta fetch scoped to just the
  // active hive (cheap; only when a hive is selected).
  const [hiveShareViz, setHiveShareViz] = useState<HiveShareVisibility | null>(null);
  useEffect(() => {
    if (!activeIsHive || !singleSlug) {
      setHiveShareViz(null);
      return;
    }
    let alive = true;
    void defaultFetchShareMeta(singleSlug)
      .then((meta) => {
        if (!alive) return;
        setHiveShareViz(meta?.found ? (meta.visibility ?? 'private') : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeIsHive, singleSlug]);
  const activeHiveShared = hiveShareViz === 'public' || hiveShareViz === 'invite';

  return (
    <div className="pc-potbar" aria-label={`${t('pot')} scope`}>
      <div className="pc-advshell__selector">
        <span className="pc-advshell__selector-label">{t('pot')}</span>
        <Select
          value={allMode ? ALL_HARNESSES_OPTION : (activeSlug ?? '')}
          onChange={async (next) => {
            if (next === '__loading') return;
            if (next === ALL_HARNESSES_OPTION) {
              // Route "all" to the scope axis — leave ?slug= holding the last real
              // pot so switching back is one click. Persist the ALL choice too so a
              // fresh load restores it (AdvShell's projects/lite effect replays it).
              void setScopeMode('all');
              if (typeof window !== 'undefined') {
                window.localStorage.setItem(wsLocalKey('harness.activeProject'), ALL_HARNESSES_OPTION);
              }
              return;
            }
            // Picking a concrete pot exits "all" mode, back to the sub-pot-union
            // default so the choice actually scopes views. SEQUENTIAL (await): the
            // custom nuqs adapter merges each write over the LIVE search, so a
            // same-tick scope+slug pair collides and the scope write is lost — the
            // pick would stay stranded in all-mode.
            if (allMode) await setScopeMode('expanded');
            await setActiveSlug(next);
            // Picking a hive must RESET the within-hive member focus (?harness=) so
            // the Work dock re-scopes to THIS hive. Sequential await, same reason.
            await setActiveHarness(null);
            if (next && typeof window !== 'undefined') {
              window.localStorage.setItem(wsLocalKey('harness.activeProject'), next);
            }
          }}
          disabled={projects.length === 0}
          ariaLabel={`Select ${t('pot')}`}
          placeholder={projectLoadError ? `Failed to load ${t('pot', { plural: true })}` : `Select ${t('pot')}`}
          options={buildHarnessSelectOptions(projects, projectLoadError, t('pot', { plural: true }), workspaceLabel)}
          triggerClassName="pc-advshell__select-trigger"
        />
        {/* Sub-pot union is meaningless under "all" (everything is already
            included), so the toggle only shows for a single pick. */}
        {!allMode && (
          <Tooltip label={`Include sub-${t('pot', { plural: true, lower: true })} in list views (plans, sessions). Editor views still focus a single ${t('pot')}.`}>
            <label className="pc-advshell__scope-toggle">
              <Checkbox
                checked={scopeMode === 'expanded'}
                onChange={(checked) => void setScopeMode(checked ? 'expanded' : 'self')}
                ariaLabel={`Include sub-${t('pot', { plural: true, lower: true })}`}
              />
              <span>sub-{t('pot', { plural: true, lower: true })}</span>
            </label>
          </Tooltip>
        )}
        <Tooltip label={`Create or add a new ${t('pot')}`}>
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--new"
            onClick={() => void setCreateOpen(true)}
          >
            <Plus size={13} aria-hidden /> New
          </button>
        </Tooltip>
        {!allMode && activeSlug && activeIsHive && (
          activeHiveShared ? (
            // Already shared to the directory → a passive Shared badge in place of
            // the Share button (manage/change visibility from the Work tab's hive
            // header).
            <Tooltip label={`${activeSlug} is shared to the directory (${hiveShareViz}) — manage sharing from the Work tab`}>
              <span className="pc-advshell__action pc-advshell__action--shared">
                <Check size={13} aria-hidden /> Shared
              </span>
            </Tooltip>
          ) : (
            <Tooltip label={`Share ${activeSlug} — publish the ${t('pot', { lower: true })} to the P2P directory so others can join`}>
              <button
                type="button"
                className="pc-advshell__action pc-advshell__action--share"
                onClick={() => void setShareOpen(true)}
              >
                <Share2 size={13} aria-hidden /> Share
              </button>
            </Tooltip>
          )
        )}
        {!allMode && activeSlug && !activeIsHive && activeIsShared && (
          <span
            className="pc-advshell__action pc-advshell__action--shared"
            title={`${activeSlug} carries a legacy per-harness share (shared.json) — sharing now happens at the ${t('pot', { lower: true })} level`}
          >
            <Check size={13} aria-hidden /> Shared
          </span>
        )}
      </div>
      {/* The status cluster — HUD only (owner ask 2026-07-27). Pots running +
          workspace-wide agents running + this pot's start/stop and "N plans
          waiting" nudge + its Discord link. */}
      {withStatus && (
        <>
          <HivesRunningPill />
          <AgentsRunningPill />
          <AdvNowRunning slug={singleSlug} />
          <DiscordBadge slug={singleSlug} />
        </>
      )}
    </div>
  );
}
