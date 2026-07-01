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
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): complete ONE inline
 * ({ id, completion }) or MANY (items:[{ id, completion, state?, harness? }]) →
 * { ok, results:[{ ok, id, workItem, completion, reflect, stateError? } | { ok:false,
 * id, error }], counts }. Each completion record is per-item (there is no shared-
 * record homogeneous form). The completion emit + plan-item reflect fire per item
 * (D-007), so a bulk complete broadcasts N completion notifications, one per item.
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
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { activeWorkspaceId } from '../../workspace-registry';
import { itemTestGate } from '../../harness-test-gate';
import { FEATURE_TERMINAL_STATES, normalizeFeatureStateInput } from '../../work-item-dispatch-states';

const completionSpec = CompletionRecordSchema.extend({ workItem: z.string().min(1).optional() });

/**
 * EI-5269: the canonical terminal states across BOTH families (feature: passed/deprecated;
 * issue: resolved/closed — see work-items.ts). A completion that leaves the item in ANY other
 * state has NOT closed it, so the row stays claimable + reclaimable.
 */
const TERMINAL_WORK_ITEM_STATES = new Set(['passed', 'deprecated', 'resolved', 'closed']);

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  /** Optional terminal state to also set (e.g. 'passed'|'resolved'|'closed').
   *  Omit to record + emit the completion WITHOUT changing lifecycle state. */
  state: z.string().min(1).max(40).optional(),
  /** The structured completion record (D-004). `workItem` defaults to this item's `id`. */
  completion: completionSpec,
  /**
   * Optional kind-specific STRUCTURED OUTPUT the completion produced (domain-free).
   * Carried verbatim onto the completion result + the completion reaction event, so a
   * domain reaction rule can read the work's output WITHOUT a re-fetch. Example: an
   * analyst bee completing a `bet-analysis` item attaches its `Signal` here, and the
   * `oddsmith:bet-signal` reaction (decision-ledger/bet-signal-rule.ts) emits a
   * decision-ledger disposition from it. Stays out of the fixed `completion` record.
   */
  outputPayload: z.unknown().optional(),
});

type CompleteItem = z.infer<typeof itemSpec>;

/** Complete ONE item — confirm it exists, optionally transition state (a failed
 *  state write NEVER loses the completion, EI-24), fill provenance defaults, and
 *  return the reflect step. Self-describes its id. */
async function completeOne(it: CompleteItem, ident: { ownerId: string; ownerLabel?: string }): Promise<BulkItemResult> {
  const existing = await getWorkItem(it.id, it.harness);
  if (!existing) return { ok: false, id: it.id, error: `work_item '${it.id}' not found` };

  // TEST-COMPLETION GATE (enforce-system-on-generic-work-2026-06-29 P-006). A feature
  // work-item being moved to a TERMINAL state must have every plan-derived test-requiring
  // VAL passing. Flag-gated (FLAGS.TEST_COMPLETION_GATE, default OFF → inert) and FAIL-OPEN
  // (itemTestGate returns ok:true on any error, never blocking a completion on a gate bug).
  // On refusal we return the SAME shape as the not-found case (ok:false + error, NO completion
  // record) so the completion emit rule — which keys on result.completion — fires no false
  // completion notification.
  if (it.state && existing.family === 'feature' && existing.harness) {
    const norm = normalizeFeatureStateInput(it.state);
    const isTerminal = norm.ok && FEATURE_TERMINAL_STATES.includes(norm.state);
    if (isTerminal && (await getFlag(FLAGS.TEST_COMPLETION_GATE, activeWorkspaceId()).catch(() => false))) {
      const gate = await itemTestGate(existing.harness, it.id);
      if (!gate.ok) return { ok: false, id: it.id, error: `refusing to complete ${it.id}: ${gate.reason}` };
    }
  }

  // Optional explicit terminal transition. A failed state write must NEVER lose the
  // completion record (EI-24): catch, report it as `stateError`, still record + emit.
  let workItem = existing;
  let stateError: string | undefined;
  if (it.state) {
    try {
      workItem = (await setWorkItemState(it.id, it.state, { harness: it.harness, by: ident.ownerId })) ?? existing;
    } catch (e) {
      stateError = e instanceof Error ? e.message : String(e);
    }
  }

  // EI-5269: `completion.status` (defaults to 'done') is NOT the state transition — only the
  // top-level `state` arg moves the row terminal. Completing WITHOUT a terminal `state` records
  // the completion (so it READS as done) but leaves the item non-terminal → still claimable, and
  // the stale-reclaim sweep re-places work on it (real duplicate bee spawns the reporter hit). We
  // deliberately do NOT auto-close (that would step on the validator/reviewer pipeline's own status
  // semantics — state is optional BY DESIGN, D-004). Instead we make the silent footgun LOUD: warn
  // whenever the item is non-terminal after this completion, so the caller re-calls with a terminal
  // `state` (exactly the fix the reporter applied). Also fires when an explicit `state` write failed
  // (stateError) or landed on a non-terminal state — in every case the item is still claimable.
  const finalState = (workItem?.state ?? existing.state ?? '').toLowerCase();
  const stateWarning =
    finalState && !TERMINAL_WORK_ITEM_STATES.has(finalState)
      ? `recorded a completion for ${it.id} but it is NOT closed — still '${workItem?.state ?? existing.state}', so it stays claimable and the auto-loop may re-place work on it. Pass top-level \`state\` (feature: 'passed'|'deprecated'; issue: 'resolved'|'closed') to close it.`
      : undefined;

  // Fill provenance defaults so the rendered notification is complete (D-006).
  const completion = {
    ...it.completion,
    workItem: it.completion.workItem || it.id,
    agent: it.completion.agent || ident.ownerLabel || ident.ownerId,
    planSlug: it.completion.planSlug,
  };

  // Reflect-and-capture STEP at the completion boundary (self-learning-central P-001/B).
  const reflect = renderReflectStep({ harnessActive: Boolean(workItem?.harness) });

  return {
    ok: true,
    id: it.id,
    workItem,
    completion,
    reflect,
    ...(it.outputPayload !== undefined ? { outputPayload: it.outputPayload } : {}),
    ...(stateError ? { stateError } : {}),
    ...(stateWarning ? { stateWarning } : {}),
  };
}

export default defineTool({
  name: 'work_items:complete',
  profile: 'engineer',
  description:
    'Finish one OR many work-items with a STRUCTURED completion record (what landed / migrations / tests / deferred-set) instead of a hand-written coord:send prose dump. The system renders + broadcasts each completion from the fields — you spend no tokens narrating. Optionally also transitions each item to a terminal `state`. Single: { id, completion }. Many: items:[{ id, completion, state?, harness? }]. Returns { ok, results:[{ ok, id, workItem, completion, reflect, stateError? } | error], counts } — act on each returned `reflect` step once, now.',
  guidance: {
    when: 'You finished work-item(s) / plan-item(s) / brief(s). Fill the structured completion fields (summary, whatLanded, migrations, tests, deferred) — do NOT also coord:send a prose summary; this emits it. To CLOSE the item, pass a terminal top-level `state` (feature: \'passed\'|\'deprecated\'; issue: \'resolved\'|\'closed\') — `completion.status` alone records the completion but does NOT change state, so the item stays claimable + reclaimable (you get a `stateWarning` when it does). Finish several at once via items:[…].',
    notWhen: 'For a contextual aside that is not a completion (a question, a design note), use coord:send. To only change state without a completion record, use work_items:set_state.',
    chaining: 'work_items:claim → … → work_items:complete { id, completion }. The completion auto-emits to coord:inbox; no coord:send needed. Then read each returned `reflect` step (self-learning loop): if any friction marker bit you, file it once via improvements:capture — else capture nothing.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // INTRINSIC emission (D-002/D-004): a completion always auto-broadcasts its
  // structured record as a coord notification. The desugar registers this as an
  // event-reaction rule (`emits:work_items:complete#completion`); the render
  // stays PURE — the engine owns dispatch/durability/loop-protection. With the
  // bulk envelope it fires PER completed item via the D-007 event-layer fan-out.
  emits: [
    {
      fire: 'coord:emit',
      // Only when the handler returned a real completion record (i.e. the item
      // existed). A not-found returns { ok:false } with no completion. The D-007
      // fan-out hands this rule one per-item event whose result.data IS the item.
      when: (e) => Boolean((e.result?.data as { completion?: unknown } | undefined)?.completion),
      render: (e) => {
        const data = e.result.data as {
          completion: CompletionRecord;
          workItem?: { family?: 'feature' | 'issue'; harness?: string | null; id?: string };
        };
        const rec = data.completion;
        const { summary, body } = renderCompletion(rec);
        // Scope to watchers (coord-emit-subscription-scoping-2026-06-05): peers on
        // the completed item's plan + the item's own object subscribers.
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
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-complete shorthand: the work-item id (use with `completion`)'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
      /** Optional terminal state to also set (single-complete shorthand). */
      state: z.string().min(1).max(40).optional(),
      /** The structured completion record (single-complete shorthand). */
      completion: completionSpec.optional(),
      items: z.array(itemSpec).min(1).max(100).optional().describe('complete many work-items at once — each { id, completion, state?, harness? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && Boolean(a.completion)), {
      message: 'pass { id, completion } for one, or items:[{ id, completion }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list: CompleteItem[] = args.items?.length
      ? args.items.map((it) => ({ ...it, harness: it.harness ?? args.harness }))
      : [{ id: args.id as string, harness: args.harness, state: args.state, completion: args.completion! }];
    const env = await runBulk(list, (it) => completeOne(it, ident), { keyOf: (it) => ({ id: it.id }) });
    return bulkContent(env);
  },
});
