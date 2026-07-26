/**
 * AgentsTab — everything about agents, in two lanes.
 *
 * LANES (owner ask 2026-07-25: "The agents tab should have two subtabs the same
 * way the mugtab has the 'now' and 'work' subtab, for 'routines' and
 * 'dynamic'"), built from the SAME `pc-auto__lane*` strip the Mug uses, so the
 * two panes read as siblings in one rail:
 *
 *   • ROUTINES — the scheduled-agent catalog (AutomationPane): every routine in
 *     supervision / health / agent-loops, which of them can spend tokens, and a
 *     pause for each. This is the lane the tab opened on before, so it stays the
 *     default.
 *   • DYNAMIC — the LIVE agent roster (owner: "the agents tab used to have a
 *     list of all active agents, what happened to it? Bring that back"). That
 *     roster is SwarmTab, which left this rail for the op-chat sidebar under
 *     WI-5162; the pane itself never went anywhere, so this remounts it rather
 *     than growing a second roster that could disagree with the first about who
 *     is running.
 *
 * The two lanes are the honest split of what "an agent" means here: a routine is
 * a SCHEDULE that will spawn one, a dynamic agent is one running right now. The
 * old single-lane tab could only ever show the first, which is why the roster
 * read as missing.
 *
 * ASK sits above both lanes (owner ask 2026-07-25: "the ask tab should be in the
 * agents pane not the conversations pane"). It is collapsed by default so it
 * costs one row of height in the compact Routines view, and belongs to neither
 * lane because addressing an agent is the tab's primary action, not a view.
 */
import { useMemo } from 'react';
import { Bot, CalendarClock, Users } from 'lucide-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { CATCH_ALL_PANE_CATEGORIES } from '@papercusp/operator-core/lib/automation/pane-categories';
import type { AutomationCatalog } from '@papercusp/operator-core/lib/automation/catalog';
import AutomationPane, { scheduleLaneValue } from './AutomationPane';
import AskAgentPane from './AskAgentPane';
import SwarmTab from './SwarmTab';
// Relative, not `@/…`: the `@` alias points at the operator (Next) tree.
import { isRunningAgent, type RosterAgent } from '../adv/AgentsRunningPill';

/**
 * The catch-all categories are DERIVED in the catalog, never listed here.
 *
 * This used to be the hand-written array `['supervision','health','agent-loops']`
 * under a comment claiming "no routine can exist without appearing in exactly one
 * of the three panes". That was false: `infra` was in nobody's list, so 40
 * routines — 39 of them ACTIVE, including git-sync, green-checkpoint and
 * hive-git-gc — were surfaced nowhere in the rail. Importing the derived list
 * means a category can never again be orphaned by omission.
 */
const CATEGORIES = CATCH_ALL_PANE_CATEGORIES;

export const AGENT_VIEWS = ['routines', 'dynamic'] as const;
export type AgentView = (typeof AGENT_VIEWS)[number];

/** advRoster.list returns a single-element array wrapping the roster object. */
interface RosterResponse {
  active: RosterAgent[];
}

export default function AgentsTab({ active }: { active: boolean }) {
  const [view, setView] = useQueryState(
    'qAgents',
    parseAsStringLiteral(AGENT_VIEWS).withDefault('routines'),
  );

  // Both reads are the SAME cached queries their lanes already issue (identical
  // queryName + args ⇒ one cache entry, one fetch), so summarising them on the
  // lane buttons costs nothing extra.
  const cat = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 20_000,
    enabled: active,
  });
  const roster = useSyncQuery<RosterResponse>({
    queryName: 'advRoster.list',
    args: { workspaceId: null, endedLimit: 20 },
    enabled: active,
    staleTime: 8_000,
  });

  const routineValue = useMemo(() => {
    const rows = (cat.data?.[0]?.routines ?? []).filter((r) => CATEGORIES.includes(r.category));
    return cat.loading && rows.length === 0 ? '…' : scheduleLaneValue(rows);
  }, [cat.data, cat.loading]);

  const runningCount = useMemo(
    () => (roster.data?.[0]?.active ?? []).filter(isRunningAgent).length,
    [roster.data],
  );
  // Guard on the DERIVED count, not on `!roster.data`, to match the Routines lane
  // above. The sync layer can hand back a present-but-empty `data` while the first
  // real read is still in flight, and `!roster.data` is false the moment that
  // happens — so the old guard flashed a confident "0 running" (and SwarmTab's
  // "fleet · 0 live") over a fleet of ~75, which reads as "the roster is broken"
  // in exactly the pane this tab exists to show. Verified live 2026-07-25: the
  // lane settled to "75 running" ~3s after the misleading 0.
  const dynamicValue = roster.loading && runningCount === 0 ? '…' : `${runningCount} running`;

  const lanes = [
    { id: 'routines' as const, label: 'Routines', value: routineValue, icon: CalendarClock },
    { id: 'dynamic' as const, label: 'Dynamic', value: dynamicValue, icon: Users },
  ];

  if (!active) return null;

  return (
    <div className="pclsb-agents" data-testid="agents-tab">
      <AskAgentPane active={active} />

      <div className="pc-auto__lanes" role="tablist" aria-label="Agents views">
        {lanes.map((lane) => {
          const Icon = lane.icon;
          const selected = lane.id === view;
          return (
            <button
              key={lane.id}
              id={`agents-lane-${lane.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`agents-panel-${lane.id}`}
              className="pc-auto__lane"
              onClick={() => void setView(lane.id)}
              data-testid={`agents-lane-${lane.id}`}
            >
              {/* Inner span carries the icon+copy row. WebKitGTK — the Tauri
                  webview this ships in — IGNORES flex set on a <button>
                  element, so declaring this row on the button itself stacked
                  the icon on top of the label on the real desktop while
                  looking correct in Chromium (EI-18135716653974462 / WI-5581,
                  the same defect the HUD board was migrated off after an
                  owner-screenshotted regression). Keep the layout in here. */}
              <span className="pc-auto__lane-inner">
                <span className="pc-auto__lane-icon">
                  <Icon size={13} aria-hidden />
                </span>
                <span className="pc-auto__lane-copy">
                  <span className="pc-auto__lane-label">{lane.label}</span>
                  <span className="pc-auto__lane-value">{lane.value}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div
        id={`agents-panel-${view}`}
        role="tabpanel"
        aria-labelledby={`agents-lane-${view}`}
        className="pclsb-agents__panel"
      >
        {view === 'routines' ? (
          <AutomationPane
            active={active}
            categories={CATEGORIES}
            title="Agents"
            subtitle="Everything else on a schedule"
            icon={Bot}
            // Copy widened with the category set: this pane now also carries
            // `infra` (git-sync, green-checkpoint, GC, release), which are pure
            // system sweeps and spawn no agent. Saying "every other scheduled
            // agent" while listing git-sync would misdescribe them — the whole
            // point of the pane is telling what spends money from what doesn't.
            blurb="Everything else that runs on a schedule — supervision, health sweeps, system infrastructure (git-sync, checkpoints, GC) and armed continuation loops. Only rows marked “tokens” spend money; the rest are free system sweeps."
          />
        ) : (
          // The live roster, unchanged — same membership rule, same fleet
          // colouring, same expandable rows as everywhere else it appears.
          <SwarmTab active={active} />
        )}
      </div>
    </div>
  );
}
