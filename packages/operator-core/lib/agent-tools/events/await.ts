/**
 * events:await — register a one-shot WAKE subscription on an event key
 * (await-event-primitive-2026-06-05 P-003, D-002/D-003).
 *
 * "I am blocked on this; re-invoke me when it fires." The caller's session
 * wake-handle (adv_sessions row via the coord SID, or an explicit plan-run id)
 * is stamped onto the subscription NOW — it cannot be fetched at fire time
 * because the agent is asleep. One-shot by construction: it fires once and
 * clears, so an await can never wake-loop.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait } from '../../events/await/store';
import { startAwaitSweeper } from '../../events/await/engine';

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

const DEFAULT_TIMEOUT_SEC = 4 * 60 * 60; // 4h
const MAX_TIMEOUT_SEC = 7 * 24 * 60 * 60; // 7d

export default defineTool({
  name: 'events:await',
  description:
    'Register a one-shot WAKE subscription on an exact event key (e.g. lock:grant:<ticket>, plan-run:finished:<id>, or any key a source/peer will events:emit) — the named sugar for watch(key,{wake:true,once:true}). When it fires you are re-invoked — a live managed-pty session gets the wake injected as a turn; an exited session is resumed with the wake reason as the prompt; an open terminal we cannot inject gets an inbox nudge and is resumed when it exits. Then END YOUR TURN — do not poll or hold the connection.',
  guidance: {
    when: 'You need X-to-happen-before-you-proceed and X is announced as an event: a lock grant, a plan-run finishing, a peer answering, CI/deploy landing, a custom key a collaborator will emit. Register, optionally tell the emitter the key, then end your turn and sleep.',
    notWhen:
      'Ambient interest in an area — that is topics:subscribe (notify; never wakes). Sub-minute waits inside one turn — just do the bounded blocking call. Recurring schedules — the pot/routines own time-based wakes; an await is ONE-shot.',
    chaining:
      'events:await { event } → end your turn. On wake, the turn text carries the event + payload — continue the blocked work. events:cancel to retract; events:status to inspect your active awaits + recent wakes.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: z
      .string()
      .min(1)
      .max(200)
      .describe('Exact event key to wait on (string match — no globs).'),
    note: z
      .string()
      .max(300)
      .optional()
      .describe('Why you are waiting — echoed into the wake turn so resumed-you has the thread.'),
    timeout_sec: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_SEC)
      .optional()
      .describe(`Deadline in seconds (default ${DEFAULT_TIMEOUT_SEC}). See on_timeout.`),
    on_timeout: z
      .enum(['wake', 'expire'])
      .optional()
      .describe(
        "What happens at the deadline without the event: 'wake' (default) = you are woken with a TIMEOUT marker (the non-event is as actionable as the event); 'expire' = the await lapses silently (visible in events:status).",
      ),
    plan_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('When awaiting FROM a plan run, pass its runId — the wake re-invokes the run via the plans:resume path instead of a session resume.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    startAwaitSweeper();

    // ── Capture the wake handle NOW (D-003) ────────────────────────────
    const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
      planRunId: args.plan_run_id,
    });

    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: args.event,
      policy: 'wake',
      note: args.note ?? null,
      wakeHandle: handle,
      timeoutBehavior: args.on_timeout ?? 'wake',
      timeoutSec: args.timeout_sec ?? DEFAULT_TIMEOUT_SEC,
      workspaceId: identity.workspaceId ?? undefined,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            await_id: row.id,
            event: row.eventKey,
            expires_ts: row.expiresTs,
            on_timeout: row.timeoutBehavior,
            wake_handle: handleNote,
            advice:
              'Registered. End your turn now — you will be re-invoked when the event fires (or at the deadline). Do not poll.',
          }),
        },
      ],
    };
  },
});
