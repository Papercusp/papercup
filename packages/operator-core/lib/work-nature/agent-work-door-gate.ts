/**
 * The agent-work gate at the work_items WRITE doors (enterprise-data-sources-2026-10-01
 * D-035, WI-10005358).
 *
 * D-024 made the by-id claim refuse a row that is not agent work by CATEGORY (nature
 * 'work' AND audience 'agent'). The two other doors that act on a row by id —
 * work_items:set_state and work_items:complete — never checked it, so an agent holding a
 * record, document, event or human-audience row's id could work that row without ever
 * claiming it. A real-model run of the S36 drain scenario did exactly that (test_runs
 * 20493622).
 *
 * This is the ONE place both doors ask the question, and it asks it with the claim's own
 * lookup ({@link readNonAgentWorkCategory}, which applies the same SQL function as the
 * claim UPDATE). So the doors and the claim cannot disagree about what agent work is.
 *
 * There is deliberately no override argument: the refusal is a category fact about the row
 * that waiting or retrying cannot change. If a legitimate agent-door caller of non-agent
 * rows turns up, raise it to the plan leader before adding any bypass (D-035).
 *
 * Failure semantics: a read failure THROWS. The bulk runner turns it into a per-item
 * `ok:false`, so an outage never becomes a silent grant and never fabricates a refusal.
 */
import { getWorkItem, readNonAgentWorkCategory } from '../work-items';

export const NOT_AGENT_WORK = 'not_agent_work' as const;

/** The write doors that gate on the category half of the agent-work predicate. */
export type AgentWorkDoor = 'work_items:set_state' | 'work_items:complete';

export interface NotAgentWorkRefusal {
  ok: false;
  id: string;
  error: typeof NOT_AGENT_WORK;
  door: AgentWorkDoor;
  nature: string;
  audience: string | null;
  hint: string;
}

/**
 * Returns the typed refusal when `id` resolves to a row that is not agent work by
 * category, else null. An absent row yields null: the door's own write path reports
 * not-found, so the gate does not invent a second spelling of that error.
 */
export async function refuseNonAgentWorkAtDoor(
  door: AgentWorkDoor,
  id: string,
  harness?: string | null,
): Promise<NotAgentWorkRefusal | null> {
  const current = await getWorkItem(id, harness ?? undefined);
  if (!current) return null;
  // Scope the category read to the harness the row ACTUALLY resolved in: a bare WI-<n> id
  // is not globally unique, so the requested harness can name a different row.
  const rowHarness = current.harness ?? harness ?? null;
  if (!rowHarness) return null;
  const category = await readNonAgentWorkCategory(id, rowHarness);
  if (!category) return null;
  return {
    ok: false,
    id,
    error: NOT_AGENT_WORK,
    door,
    nature: category.nature,
    audience: category.audience,
    hint:
      `This row is nature '${category.nature}'${category.audience ? `, audience '${category.audience}'` : ''}, ` +
      "not agent work (nature 'work', audience 'agent'), so no agent may change its state or complete it " +
      `through ${door} — the same rule that refuses it at the by-id claim. Do not retry. ` +
      'A human-audience item is acted on by its owner; a record, document or event is data to read, not work.',
  };
}
