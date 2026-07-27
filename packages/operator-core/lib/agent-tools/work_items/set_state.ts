/**
 * work_items:set_state — Lifecycle (D-003). Sets the UNIFIED lifecycle state for BOTH
 * families (work-item-status-full-unify P-003 writer-flip): open|wip|blocked|needs-human|
 * done|dropped. Legacy per-family spellings (feature passed/deprecated/todo/…, issue
 * resolved/closed) still fold to unified via the alias maps, preserving the passed/resolved
 * vs deprecated/closed nuance in work_items.terminal_reason.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): set ONE inline
 * ({ id, state }), MANY to the SAME state (ids:[…] + state), or MANY heterogeneous
 * (items:[{ id, state, harness?, decision? }]) → { ok, results:[{ ok, id, workItem?
 * | error }], counts }. The P-114 arm tripwire is evaluated PER item; the
 * plan-item reflect + rationale-reproject reactions fire per item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemStateWithAliasInfo } from '../../work-items';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';
import { runBulk, bulkContent } from '../_bulk';
import { assumptionsArg, hasAssumptionDeclaration, ASSUMPTIONS_REQUIRED_MESSAGE } from './_assumptions';
import {
  TERMINAL_INPUT_STATES,
  NON_TERMINAL_INPUT_STATES,
  isTerminalStateInput,
} from '../../work-item-dispatch-states';

// P-114: an AUTONOMOUS agent declares the action's risk/authority so the auto-revert
// tripwire arms faithfully to the upstream decision (the verb has no inherent item
// risk). Absent ⇒ fail-safe `critical`. Ignored for human callers.
const decisionSpec = z.object({
  riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
  authority: z.enum(['system', 'owner']).optional(),
});

/**
 * P-005 / D-006: the terminal-state evidence requirement is STRUCTURAL, not described.
 *
 * It used to live in `completionRef`'s .describe() ("REQUIRED alongside a terminal
 * state") while the schema said `.optional()` — precisely the IFEval-FC failure mode
 * this plan cites (models frequently miss format rules embedded in JSON-schema
 * descriptions; D-004: a rule that matters gets an enum or a validator, never a
 * sentence). `state` was worse still: a bare z.string().max(40), so the valid
 * vocabulary was prose too and a typo landed in a non-dispatchable limbo (the GAP-5
 * harm) rather than being rejected.
 *
 * Now a terminal write WITHOUT evidence is UNREPRESENTABLE: the discriminated union
 * renders as two distinct shapes in the generated tool schema, so the model SEES
 * that `done` requires completionRef and `wip` does not, instead of reading it.
 *
 * Both state sets are DERIVED in work-item-dispatch-states.ts from the alias map +
 * terminal sets — never hand-listed here, so a new alias cannot drift this gate away
 * from the runtime writer (the hand-copy drift that caused EI-18653071581558556).
 */
const asEnumValues = (v: readonly string[]) => v as unknown as [string, ...string[]];

/** Trim + lower-case ONLY, matching normalizeFeatureStateInput's own folding, so the
 *  union accepts exactly what the runtime writer already accepted (case drift like
 *  `DONE` keeps working — this gate adds structure, it does not narrow acceptance). */
const foldStateCase = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

const itemBase = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  decision: decisionSpec.optional(),
  force: z
    .boolean()
    .optional()
    .describe(
      'EI-7422: required to REOPEN an item that already carries a terminal completion (terminalOwner + terminalCompletionRef) — without it the write is REJECTED rather than silently discarding a peer\'s completion. Only needed when the target is already terminal AND you are deliberately reopening it.',
    ),
});

const terminalItem = itemBase.extend({
  state: z.preprocess(foldStateCase, z.enum(asEnumValues(TERMINAL_INPUT_STATES))),
  completionRef: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'REQUIRED for this terminal state — completion evidence (summary / commit / coord or plan-item ref). Prefer work_items:complete for a structured completion record.',
    ),
  // P-017 (b) gate #2 / D-016 / D-050: `assumptions` joins the SAME terminal branch
  // that already carries `completionRef`, so BOTH requirements render in the one
  // schema shape the model sees — evidence for the claim, and the assumptions the
  // claim rests on. Non-terminal writes carry neither field at all.
  assumptions: assumptionsArg,
});

const nonTerminalItem = itemBase.extend({
  state: z.preprocess(foldStateCase, z.enum(asEnumValues(NON_TERMINAL_INPUT_STATES))),
});

const itemSpec = z.union([terminalItem, nonTerminalItem]);

export default defineTool({
  name: 'work_items:set_state',
  profile: 'engineer',
  description:
    'Set lifecycle state for one OR many work-items. BOTH families store the UNIFIED enum: open|wip|blocked|needs-human|done|dropped (open = the single claimable token; legacy feature passed/deprecated + issue resolved/closed are still accepted and fold to done/dropped, preserving the nuance in terminal_reason). EI-9360: an issue set needs-human auto-sets payload.needsHuman; blocked auto-applies the WI-2797 self-select claim hold — both durably exclude the item from claim_next/scheduler:get_next (still directly claimable by id) without a separate call; see aliasNote. Reopening another agent\'s terminal completion is rejected unless `force:true`. Single: { id, state }. Many same state: { ids:[…], state }. Many heterogeneous: items:[{ id, state, harness?, decision?, force? }]. Returns { ok, results:[{ ok, id, workItem?, aliased, requestedState, appliedState, aliasNote? | error }], counts } — check `aliased`/`appliedState`, not just `ok` (EI-7712).',
  guidance: {
    when: 'Use after moving lifecycle. Batch a wave with { ids:[…], state } or items:[…]. Prefer work_items:complete for terminal evidence. needs-human/blocked auto-exclude from self-select (EI-9360) — no extra call needed; un-park blocked via release{claimHold:false}. If already terminally completed, read terminalOwner/ref before any `force:true` reopen.',
    chaining: 'work_items:claim → … → work_items:set_state { state }.',
    seeAlso: [
      'work_items:complete (terminal state WITH a structured completion record)',
      'work_items:release (drop a claim without changing state; claimHold:true parks an issue-family item out of claim_next self-select — WI-2797)',
      'work_items:set_priority (steer backlog order, not lifecycle state)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `state`)'),
      state: z
        .preprocess(foldStateCase, z.enum(asEnumValues([...TERMINAL_INPUT_STATES, ...NON_TERMINAL_INPUT_STATES])))
        .optional()
        .describe('the lifecycle state applied to the inline id / every id in `ids` — a terminal state REQUIRES `completionRef`'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      decision: decisionSpec.optional().describe('P-114 risk/authority for the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('set MANY items to the same `state` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('set many work-items at once — each { id, state, harness?, decision?, completionRef? }'),
      completionRef: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('completion evidence applied to the inline id / every id in `ids` (see itemSpec.completionRef)'),
      // P-017 (b) gate #2: `.optional()` ONLY because an items[]-only call carries its
      // own per-item value. The requirement for the inline / ids[] shorthand is closed
      // by the refine below — without it the gate would MOVE to the shorthand, which is
      // the cheaper call and would therefore carry all the traffic.
      assumptions: assumptionsArg
        .optional()
        .describe('assumption declaration applied to the inline id / every id in `ids` (see itemSpec.assumptions)'),
      force: z
        .boolean()
        .optional()
        .describe('applied to the inline id / every id in `ids` (see itemSpec.force) — required to reopen an already-terminally-completed item'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.state) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))), {
      message: 'pass { id, state } for one, { ids:[…], state } for many of the same state, or items:[{ id, state }] for many',
    })
    // P-005: the SAME structural rule the items[] union enforces, applied to the
    // inline / ids[] shape. itemSpec's union cannot cover these — `state` and
    // `completionRef` live at the top level there — so without this the evidence
    // requirement would simply MOVE to the shorthand rather than being closed.
    .refine((a) => !(a.state && isTerminalStateInput(a.state) && !a.completionRef), {
      path: ['completionRef'],
      message:
        'a terminal state requires completion evidence — pass `completionRef`, or (preferred) use work_items:complete for a structured completion record',
    })
    // P-017 (b) gate #2 / D-050 — the SAME structural rule terminalItem enforces for
    // items[], applied to the inline / ids[] shape, exactly as the completionRef refine
    // above does for evidence. Two separate refines rather than one so a caller missing
    // both fields is told about both, not just whichever check ran first.
    .refine((a) => !(a.state && isTerminalStateInput(a.state) && !hasAssumptionDeclaration(a.assumptions)), {
      path: ['assumptions'],
      message: ASSUMPTIONS_REQUIRED_MESSAGE,
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // P-005: itemSpec is now a UNION (terminal carries a required completionRef;
    // non-terminal has no such field at all), so flatten to one uniform shape here
    // — every downstream reader keeps its single `it.completionRef` access.
    const list = args.items?.length
      ? args.items.map((it) => ({
          ...it,
          completionRef: 'completionRef' in it ? it.completionRef : undefined,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, state: args.state as string, harness: args.harness, decision: args.decision, completionRef: args.completionRef, force: args.force }))
        : [{ id: args.id as string, state: args.state as string, harness: args.harness, decision: args.decision, completionRef: args.completionRef, force: args.force }];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        // P-114 arm-call-site: gate-FIRST (before the mutation) so the captured prior-state
        // handle is faithful; best-effort (never fails the verb); null on the common path.
        const armPlan = await planWorkItemArm(
          ctx,
          'work_items:set_state',
          'state',
          it.id,
          harness,
          it.decision,
        ).catch(() => null);
        // EI-7712 (extends EI-7125/WI-2573): ALWAYS report the alias/no-op discriminator —
        // requestedState/appliedState/aliased on every result row, not just when the
        // normalize-layer onAlias fires — so a careless caller reading `ok` alone can no
        // longer be told ok:true for a write that landed somewhere other than what it asked
        // (the WI-2381 incident: set_state->blocked returned ok:true, state silently stayed
        // 'open', discovered only by an unrelated list read 10min later).
        const { workItem, aliased, requestedState, appliedState, aliasNote } =
          await setWorkItemStateWithAliasInfo(it.id, it.state, {
            harness,
            by: ident.ownerId,
            completionRef: it.completionRef,
            force: it.force,
          });
        if (armPlan && workItem) await commitWorkItemArm(armPlan).catch(() => {});
        return workItem
          ? {
              ok: true as const,
              id: it.id,
              workItem,
              aliased,
              requestedState,
              appliedState,
              ...(aliasNote ? { aliasNote } : {}),
            }
          : { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
