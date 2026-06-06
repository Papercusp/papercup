/**
 * work_items:complete — the STRUCTURED completion op
 * (coord-lifecycle-automation-2026-06-04 D-004, "stop narrating, emit structure").
 *
 * The single biggest token + signal win of the plan: instead of finishing a
 * unit of work and hand-writing a prose `coord:send`
 *   "F-12 BUILT+TESTED, migration 137, 40 tests, deferred X/Y…",
 * an agent calls `work_items:complete { id, completion: {…structured fields…} }`.
 * The completion event (D-002 `emits` on this tool) renders the coord
 * notification from the structured record via the pure render layer and fires
 * `coord:emit` — the agent spends zero tokens narrating, and NOTHING is lost
 * (the deferred-set especially is carried structurally, D-006).
 *
 * State transition is OPTIONAL + explicit (`state`) so this never silently
 * steps on the validator/reviewer pipeline's own status semantics — pass it to
 * also move the item to a terminal state, omit it to record+emit only.
 *
 * The `emits` rule is registered separately (../../coord-lifecycle/lifecycle-rules)
 * so the render-layer import stays out of the hot tool dispatch path; it fires
 * on `work_items:complete` and reads `result.completion`.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { objectSelector } from '../coordination/audience';
import { getWorkItem, setWorkItemState, workItemObjectRef } from '../../work-items';
import { CompletionRecordSchema, type CompletionRecord } from '../../coord-lifecycle/records';
import { renderCompletion } from '../../coord-lifecycle/render';
import { renderReflectStep } from '../../harness/improvements/friction-markers';

export default defineTool({
  name: 'work_items:complete',
  profile: 'engineer',
  description:
    'Finish a work-item with a STRUCTURED completion record (what landed / migrations / tests / deferred-set) instead of a hand-written coord:send prose dump. The system renders + broadcasts the completion notification from the fields — you spend no tokens narrating. Optionally also transitions the item to a terminal `state`. Returns a `reflect` step (the self-learning friction prompt) to act on once, now.',
  guidance: {
    when: 'You finished a work-item / plan-item / brief. Fill in the structured completion fields (summary, whatLanded, migrations, tests, deferred) — do NOT also coord:send a prose summary; this emits it.',
    notWhen: 'For a contextual aside that is not a completion (a question, a design note), use coord:send. To only change state without a completion record, use work_items:set_state.',
    chaining: 'work_items:claim → … → work_items:complete { id, completion }. The completion auto-emits to coord:inbox; no coord:send needed. Then read the returned `reflect` step (self-learning loop): if any friction marker bit you during this unit of work, file it once via improvements:capture — else capture nothing.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // INTRINSIC emission (D-002/D-004): a completion always auto-broadcasts its
  // structured record as a coord notification. The desugar registers this as an
  // event-reaction rule (`emits:work_items:complete#completion`); the render
  // stays PURE — the engine owns dispatch/durability/loop-protection.
  // Projection invariant (state-not-chat-fleet-state D-003): the work_items row
  // update IS the record; this message is a one-directional human-readable
  // projection of it — never the source. State readers query fleet_assignment /
  // work_items; change-awareness rides the fleet_assignment NOTIFY feed.
  emits: [
    {
      fire: 'coord:emit',
      // Only when the handler returned a real completion record (i.e. the item
      // existed). A not-found returns { ok:false } with no completion.
      when: (e) => Boolean((e.result?.data as { completion?: unknown } | undefined)?.completion),
      render: (e) => {
        const data = e.result.data as {
          completion: CompletionRecord;
          workItem?: { family?: 'feature' | 'issue'; harness?: string | null; id?: string };
        };
        const rec = data.completion;
        const { summary, body } = renderCompletion(rec);
        // Scope to watchers (coord-emit-subscription-scoping-2026-06-05): peers on
        // the completed item's plan (presence + subscribers) and the item's own
        // object subscribers. The work-item always exists here (the `when` gated
        // on a real completion), so `to` is never empty.
        const to: string[] = [];
        if (rec.planSlug) to.push(`@plan:${rec.planSlug}`);
        const wi = data.workItem;
        if (wi?.family && wi.id) {
          to.push(objectSelector(workItemObjectRef({ family: wi.family, harness: wi.harness ?? null, id: wi.id })));
        }
        return {
          category: 'completion',
          summary,
          ...(body ? { body } : {}),
          ...(rec.planSlug ? { plan_slug: rec.planSlug } : {}),
          to,
        };
      },
    },
  ],
  args: z.object({
    id: z.string().min(1),
    harness: z.string().max(80).optional(),
    /** Optional terminal state to also set (e.g. 'passed'|'resolved'|'closed').
     *  Omit to record + emit the completion WITHOUT changing lifecycle state. */
    state: z.string().min(1).max(40).optional(),
    /** The structured completion record (D-004). `workItem` is optional here —
     *  it defaults to this tool's `id` (don't repeat yourself). */
    completion: CompletionRecordSchema.extend({ workItem: z.string().min(1).optional() }),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);

    // Confirm the item exists (and learn its current shape).
    const existing = await getWorkItem(args.id, args.harness);
    if (!existing) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: `work_item '${args.id}' not found` }) },
        ],
      };
    }

    // Optional explicit terminal transition. The engine normalizes the state
    // onto the family's vocabulary (done→resolved for issue-family etc.) and
    // throws a TYPED error for an unmappable one — and either way a failed
    // state write must NEVER lose the completion record (EI-24): catch, report
    // it as `stateError`, and still record + emit the completion.
    let workItem = existing;
    let stateError: string | undefined;
    if (args.state) {
      try {
        workItem =
          (await setWorkItemState(args.id, args.state, { harness: args.harness, by: ident.ownerId })) ?? existing;
      } catch (e) {
        stateError = e instanceof Error ? e.message : String(e);
      }
    }

    // Fill provenance defaults so the rendered notification is complete even
    // when the caller omits them (D-006 information preservation).
    const completion = {
      ...args.completion,
      workItem: args.completion.workItem || args.id,
      agent: args.completion.agent || ident.ownerLabel || ident.ownerId,
      planSlug: args.completion.planSlug,
    };

    // Reflect-and-capture STEP at the completion boundary (self-learning-central
    // P-001/B, D-006). Completing a unit of work is the densest, cheapest moment
    // for the SUBJECTIVE friction feed-in: the agent has the full sub-arc in
    // context. The step is lifecycle-invoked HERE (like improvements:resolve is
    // invoked at the end of a dispatched fix) — once per unit of work, NOT a
    // per-turn pass. The harness-pipeline markers (validator/reviewer) only render
    // when this item ran the coding harness, so a harness-free completion never
    // sees roles that don't exist outside one. The agent files anything genuine
    // via improvements:capture; if nothing bit it, it captures nothing.
    const harnessActive = Boolean(workItem?.harness);
    const reflect = renderReflectStep({ harnessActive });

    return {
      content: [
        {
          type: 'text' as const,
          // `completion` is what the lifecycle emits-rule renders into coord:emit.
          // `reflect` is the completion-boundary friction-reflection prompt the
          // agent acts on once, now, with the full sub-arc in context.
          text: JSON.stringify({
            ok: true,
            workItem,
            completion,
            reflect,
            ...(stateError ? { stateError } : {}),
          }),
        },
      ],
    };
  },
});
