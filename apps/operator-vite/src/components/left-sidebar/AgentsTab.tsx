/**
 * AgentsTab — the CATCH-ALL automation pane: every scheduled agent that is not a
 * learning loop (Blender) or a documentation agent (Docs).
 *
 * WHY IT EXISTS (owner ask 2026-07-25): the goal is that token usage cannot happen
 * unknowingly. Blender + Docs alone leave that goal unmet — on the day this was
 * built, 13 further token-spending routines lived in supervision (7), health (2)
 * and agent-loops (4) with no owner-facing surface at all. A pane per named agent
 * would still have left those uncovered, so this one deliberately takes
 * "everything else": no scheduled spender can exist without appearing in exactly
 * one of the three panes.
 *
 * `agent-loops` are the agent-armed `loop:arm` continuation loops. There are
 * hundreds of historical registrations and almost all are inactive, so the pane's
 * shared sort (spending first, then active) is what keeps the live ones on top.
 */
import AutomationPane from './AutomationPane';

export default function AgentsTab({ active }: { active: boolean }) {
  return (
    <AutomationPane
      active={active}
      categories={['supervision', 'health', 'agent-loops']}
      title="Agents"
      blurb="Every other scheduled agent — supervision, health sweeps, and armed continuation loops. Anything marked “tokens” spends money every time it fires."
      spendRoles={['worker', 'mug', 'kettle', 'release-fixer', 'cup']}
    />
  );
}
