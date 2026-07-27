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
 * So this is a PRESET over `watch:create`, in the same sense `events:await` and
 * `topics:subscribe` are (D-007): it resolves a cell NAME to the predicate that cell
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
import { PREDICATE_OPS } from '../../events/await/predicate-watch';
import watchTool from '../events/watch';

export default defineTool({
  name: 'state:subscribe',
  description:
    'Wake me when a registered state CELL crosses a condition — instead of burning turns re-reading it. Names a cell (state:read lists them); the cell supplies the resolver + path, you supply `on: {op, value}`. A PRESET over watch:create, so it inherits its dedupe (an identical watch joins the existing poller), its inline first eval (a broken condition fails NOW; an already-true one fires immediately), and its wake floors. Fires on the false→true EDGE. A cell outside your audience is absent, not subscribable.',
  guidance: {
    when: 'You need to proceed only once a value crosses a threshold — a deploy landing, a queue draining, a holder releasing. Use it INSTEAD of a sleep/poll loop; that loop is what this exists to kill.',
    notWhen: 'You need the value now — that is state:read. The event has an exact key already — that is events:await. A recurring TIME schedule — routines own those.',
    chaining:
      'state:subscribe { cell, on:{op,value} } → END YOUR TURN. You are woken on the cross; do not poll in the meantime. once:false re-fires on each cross. Cancel via events:cancel with the returned watch id.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    cell: z.string().min(1).max(120).describe('Dotted cell id to watch, e.g. "git.pipelinePosition". state:read (no args) lists the ones you may read.'),
    on: z
      .object({
        op: z.enum(PREDICATE_OPS).describe('Comparator applied to the cell value.'),
        value: z.unknown().optional().describe('Operand (omit for `exists`).'),
      })
      .describe('The condition on the cell VALUE. Fires on the false→true edge, not on every poll that matches.'),
    as: z
      .string()
      .max(200)
      .optional()
      .describe('SUBJECT for a caller-relative cell (see state:read `as`). Not an identity override — your audience is always what is checked.'),
    once: z.boolean().optional().describe('true (DEFAULT) = fire once then clear. false = standing; re-fires on each false→true cross.'),
    interval_sec: z.number().int().min(15).max(3600).optional().describe('Poll cadence (default 60).'),
    note: z.string().max(2000).optional().describe('Why you are watching — echoed into the wake turn.'),
  }),
  async handler(args, ctx) {
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
              error: `No cell "${args.cell}" is subscribable by you. It may not exist, or it may be outside your audience — deliberately indistinguishable. Do not watch a substitute surface instead.`,
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
              error: `cell "${args.cell}" is event-signalled, not polled — subscribe to its key directly with events:await { key: "${spec.changeSignal.key}" } rather than polling for it.`,
              eventKey: spec.changeSignal.key,
            }),
          },
        ],
        isError: true,
      };
    }

    // Axis 3 — a caller-relative cell cannot be watched without its subject, for the
    // same reason it cannot be read without one: there is no question yet.
    const rel = spec.callerRelativity;
    if (rel.kind === 'parameter' && (args.as === undefined || args.as.trim() === '')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              cell: args.cell,
              error: `cell "${args.cell}" is relative to "${rel.param}" — pass \`as\` to say WHAT you are watching.`,
              missingParam: rel.param,
            }),
          },
        ],
        isError: true,
      };
    }
    const resolverArgs = rel.kind === 'parameter' ? { [rel.param]: args.as as string } : {};

    // DELEGATE. The cell contributes exactly the triple it already declares; every
    // other knob is watch:create's, unchanged. Parsing through watch:create's own
    // schema (rather than hand-building its args) means a change to that schema
    // surfaces HERE as a parse error instead of silently dropping a field.
    const watchArgs = watchTool.args.parse({
      pattern: `cell:${args.cell}`,
      wake: true,
      once: args.once ?? true,
      interval_sec: args.interval_sec,
      note: args.note ?? `cell ${args.cell} ${args.on.op}${args.on.value === undefined ? '' : ` ${JSON.stringify(args.on.value)}`}`,
      predicate: {
        tool: spec.changeSignal.tool,
        args: resolverArgs,
        path: spec.changeSignal.path,
        op: args.on.op,
        ...(args.on.value === undefined ? {} : { value: args.on.value }),
      },
    });
    return watchTool.handler(watchArgs as never, ctx);
  },
});
