/**
 * `state:subscribe` — wake me when a registered CELL crosses a condition
 * (unified-agent-state-plane-2026-07-27 P-004, per D-058).
 *
 * ── THIS TOOL ADDS NO SUBSCRIPTION MECHANISM, AND THAT IS THE POINT ─────────
 *
 * P-004 says it outright: "Reuse-first: do not add a second subscription mechanism."
 * `predicate_watches` already binds (tool, args, dot-path, comparator) and polls it
 * under the registrant's role — which is EXACTLY `CellSpec.changeSignal`'s
 * `{ kind:'poll', tool, path }`, the same triple under a different name.
 *
 * So this is a PRESET over `watch:create`, in the same sense `events:await` is
 * (D-007 — the third preset, `topics:subscribe`, was retired 2026-08-09 for taking
 * zero calls; this one is live at 25 calls/11 agents and is WHY the base primitive
 * stayed): it resolves a cell NAME to the predicate that cell
 * already declares, and hands it to the one registration path. It deliberately does
 * NOT re-implement registration — `watch:create` owns the dedupe (an identical
 * predicate JOINS an existing poller instead of starting a second), the inline first
 * eval (a broken tool/role fails loudly now, and an already-true condition fires
 * immediately), and the await/GC pairing. Duplicating ~150 lines of that here is
 * precisely the "second mechanism" the item forbids.
 *
 * What the caller gains over calling `watch:create` by hand: they name a CELL instead
 * of hand-copying a tool name and a dot-path. A hand-copied path is a transcription,
 * and a transcription rots when the resolver's shape moves — the same defect the
 * P-017 (c) detector flags. Here the cell is the single source of that triple.
 *
 * ── THE AUDIENCE CHECK RUNS HERE TOO ────────────────────────────────────────
 *
 * Subscribing is a read: it observes the cell's value on a schedule. So it goes
 * through `getCell(cell, reader)` exactly as `state:read` does, and a cell outside the
 * reader's audience is ABSENT — never subscribable. Skipping this would make
 * `state:subscribe` a bypass of `canReadCell` that returns the value one poll later,
 * which is the silent-leak hazard D-042 names and P-028 gates.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { getCell } from '../../cell-registry';
import { resolveSelfSubject } from '../../cell-suggest';
import { PREDICATE_OPS } from '../../events/await/predicate-watch';
import watchTool from '../events/watch';

export default defineTool({
  name: 'state:subscribe',
  description:
    'Wake me when a registered state CELL changes or crosses a condition — instead of burning turns re-reading it. Names a cell (state:read lists them); the cell supplies the resolver + path. `on` is OPTIONAL — omit it for "wake me when this moves" (op `changed`). A PRESET over watch:create, so it inherits its dedupe (an identical watch joins the existing poller), its inline first eval (a broken condition fails NOW; an already-true one fires immediately), and its wake floors. Fires on the false→true EDGE. A cell outside your audience is absent, not subscribable.',
  guidance: {
    when: 'You need to proceed only once a value MOVES or crosses a threshold — a deploy landing, a gate verdict flipping, a queue draining, a holder releasing. Use it INSTEAD of a sleep/poll loop; that loop is what this exists to kill.',
    notWhen: 'You need the value now — that is state:read. The event has an exact key already — that is events:await. A recurring TIME schedule — routines own those.',
    chaining:
      'state:subscribe { cell } → END YOUR TURN. Omitting `on` means `changed`; never write `ne` against the value\'s current reading to mean that — it transcribes a volatile value and misses a move landing before the call. Standing watch: no `timeout_sec`/`on_timeout`/`wake` (events:await owns those), and the why-field is `note`. once:false re-fires per change. Cancel via events:cancel.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // state-plane-adoption-2026-08-02 P-003 / D-005 — kept in lockstep with state:read's
  // allowlist: reading a cell you cannot then wait on is a half-open door, and the gate
  // verdict is the value a red-gate repairer most needs to wait on rather than re-poll.
  // release-fixer holds `coord:write` (verified: 82 coord:emit + 26 coord:declare-intent
  // + 4 coord:send successes, all `coord:write`), so the capability gate does not bite.
  // Widened at the use site, NOT via SU_ROLES — that set defines the fleet
  // capability-cutover (see the fuller note on state:read). Audience filtering still
  // applies per this tool's own contract: a cell outside your audience is absent, not
  // subscribable.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({
    cell: z.string().min(1).max(120).describe('Dotted cell id to watch, e.g. "git.pipelinePosition". state:read (no args) lists the ones you may read.'),
    on: z
      .object({
        op: z.enum(PREDICATE_OPS).describe('Comparator applied to the cell value. `changed` needs no `value` — it compares each reading to the previous one.'),
        value: z.unknown().optional().describe('Operand (omit for `exists` and `changed`).'),
      })
      .optional()
      .describe(
        'The condition on the cell VALUE. Fires on the false→true edge, not on every poll that matches. OMIT IT to mean `{op:"changed"}` — wake me when this value moves — which is what you want for a deploy sha or a gate verdict. Do NOT hand-write `ne` against the value\'s current reading to express that: it transcribes a volatile value into the watch, and if the value moves between your read and this call the watch is armed against a stale operand and never fires.',
      ),
    as: z
      .string()
      .max(200)
      .optional()
      .describe('SUBJECT for a caller-relative cell (see state:read `as`). Where the cell\'s parameter is an agent identity, the literal "self" means you. Not an identity override — your audience is always what is checked.'),
    of: z
      .enum(['value', 'material'])
      .optional()
      .describe(
        'WHICH of the cell\'s paths your condition is about. "value" (DEFAULT) = the headline value. "material" = the cell\'s declared MATERIALITY path, so a high-churn cell wakes you only on a change that matters (P-021). Refused when the cell declares no materiality — you are told the cell has none rather than silently watching the churny path.',
      ),
    once: z.boolean().optional().describe('true (DEFAULT) = fire once then clear. false = standing; re-fires on each false→true cross.'),
    interval_sec: z.number().int().min(15).max(3600).optional().describe('Poll cadence (default 60).'),
    note: z.string().max(2000).optional().describe('Why you are watching — echoed into the wake turn.'),
  }),
  async handler(args, ctx) {
    // P-004 — the default condition. 12 of 50 measured failures passed no `on` at
    // all, and 11 more invented an operator spelling for it; "wake me when this
    // moves" is simply what subscribing to a volatile cell usually means.
    const on = args.on ?? { op: 'changed' as const, value: undefined };
    const identity = resolveAgentIdentity(ctx);
    const reader = {
      ownerId: identity.ownerId,
      roles: ctx.role ? [ctx.role] : [],
      harnessSlug: ctx.harnessSlug ?? undefined,
    };

    // Gate 1, same oracle as state:read. Absent ⇒ absent: a cell you may not read is
    // not one you may watch, and the refusal must not distinguish "not registered"
    // from "not yours" (P-019's non-oracle property).
    const spec = getCell(args.cell, reader);
    if (!spec) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              status: 'absent',
              cell: args.cell,
              // P-004: `error` is lifted VERBATIM into tool_invocations.error_code by
              // the dispatcher's extractRefusalCode (truncated at 80 chars), so a prose
              // sentence here becomes an unqueryable code — which is exactly why this
              // tool's whole refusal taxonomy had to be reconstructed from error_message
              // and args_json. The code goes in `error`; the prose goes in `reason`.
              error: 'cell_absent',
              reason: `No cell "${args.cell}" is subscribable by you. It may not exist, or it may be outside your audience — deliberately indistinguishable. Do not watch a substitute surface instead.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // An event-signalled cell needs no poller at all — it already HAS a key, so the
    // correct primitive is the plain await. Registering a predicate for it would start
    // a poll against a value that pushes.
    if (spec.changeSignal.kind !== 'poll') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              cell: args.cell,
              error: 'cell_event_signalled',
              reason: `cell "${args.cell}" is event-signalled, not polled — subscribe to its key directly with events:await { key: "${spec.changeSignal.key}" } rather than polling for it.`,
              eventKey: spec.changeSignal.key,
            }),
          },
        ],
        isError: true,
      };
    }

    // P-003 — `as:"self"` resolves to the caller's own ownerId for an IDENTITY-keyed
    // cell, kept in LOCKSTEP with state:read: a subject shorthand you may read with
    // but not wait on is the same half-open door the role allowlist comment warns
    // about. Resolved BEFORE the missing-subject check below so `self` satisfies it.
    const asSubject = resolveSelfSubject(args.as, spec, identity.ownerId);

    // Axis 3 — a caller-relative cell cannot be watched without its subject, for the
    // same reason it cannot be read without one: there is no question yet.
    const rel = spec.callerRelativity;
    if (rel.kind === 'parameter' && (asSubject === undefined || asSubject.trim() === '')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              cell: args.cell,
              error: 'subject_required',
              reason: `cell "${args.cell}" is relative to "${rel.param}" — pass \`as\` to say WHAT you are watching.`,
              missingParam: rel.param,
            }),
          },
        ],
        isError: true,
      };
    }
    const resolverArgs = rel.kind === 'parameter' ? { [rel.param]: asSubject as string } : {};

    /**
     * P-021 — WHICH path the predicate watches.
     *
     * ⚠ A DECLARED MATERIALITY IS NEVER APPLIED SILENTLY, and that restraint is
     * the whole design of this knob. The caller's `on: {op, value}` is written
     * against a value they have in mind; quietly re-pointing it at a coarser
     * sibling path would not narrow their condition, it would evaluate it against
     * a DIFFERENT DOMAIN. Concretely: `on:{op:'ne', value:'4c871fdc'}` — the
     * natural "wake me when the candidate moves" — silently redirected onto a
     * BOOLEAN containment path is `ne` against a sha it can never equal, i.e. a
     * predicate that is true on the first poll. The agent would be woken
     * instantly and told it was a material change. A wake is an interrupt (D-044)
     * and a spurious one is a false all-clear that resumes an agent on a
     * condition never established — exactly what `comparePredicate`'s absent-
     * evidence rule already refuses to do one layer down.
     *
     * So materiality is OPT-IN per subscription, and asking for it on a cell that
     * declares none is an ERROR rather than a silent fallback to the churny path.
     */
    const wantsMaterial = args.of === 'material';
    if (wantsMaterial && !spec.materiality) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              cell: args.cell,
              error: 'no_materiality',
              reason: `cell "${args.cell}" declares no materiality path, so there is no coarser answer to watch. Either its every change is material (the registry's default), or it should declare one. Re-subscribe without \`of\` to watch "${spec.changeSignal.path}" — and expect a wake on every change to it.`,
              watchedPath: spec.changeSignal.path,
            }),
          },
        ],
        isError: true,
      };
    }
    const watchedPath = wantsMaterial ? (spec.materiality as { path: string }).path : spec.changeSignal.path;

    // DELEGATE. The cell contributes exactly the triple it already declares; every
    // other knob is watch:create's, unchanged. Parsing through watch:create's own
    // schema (rather than hand-building its args) means a change to that schema
    // surfaces HERE as a parse error instead of silently dropping a field.
    const watchArgs = watchTool.args.parse({
      pattern: `cell:${args.cell}`,
      wake: true,
      once: args.once ?? true,
      interval_sec: args.interval_sec,
      note:
        args.note ??
        `cell ${args.cell}${wantsMaterial ? ' (material)' : ''} ${on.op}${on.value === undefined ? '' : ` ${JSON.stringify(on.value)}`}`,
      predicate: {
        tool: spec.changeSignal.tool,
        args: resolverArgs,
        path: watchedPath,
        op: on.op,
        ...(on.value === undefined ? {} : { value: on.value }),
      },
    });
    return watchTool.handler(watchArgs as never, ctx);
  },
});
