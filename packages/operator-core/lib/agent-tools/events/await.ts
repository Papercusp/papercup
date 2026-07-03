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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait } from '../../events/await/store';
import { startAwaitSweeper } from '../../events/await/engine';
import { hardText, softText, clampText, LIMITS } from '../limits';

const DEFAULT_TIMEOUT_SEC = 4 * 60 * 60; // 4h
const MAX_TIMEOUT_SEC = 7 * 24 * 60 * 60; // 7d

export default defineTool({
  name: 'events:await',
  description:
    'Register a one-shot WAKE on an exact event key. When it fires you are re-invoked, so end your turn instead of polling.',
  guidance: {
    when: 'You are blocked on a known event key: a lock grant, plan run finishing, peer answer, deploy/gate landing, or a custom key another tool/agent will emit. Before polling, check events:catalog for an awaitable key, register it, then end your turn.',
    notWhen:
      'Ambient interest (use topics:subscribe), sub-minute waits inside one turn, or recurring schedules. Prefer the sugar verbs for common waits: deploy:await, checkpoint:await, work-item:await, service:await-up, git-sync:await, plan-item:await, fleet:await-drained.',
    chaining: 'events:catalog → events:await { event } (or a sugar verb) → end your turn. Use events:cancel to retract and events:status to inspect active awaits.',
    seeAlso: [
      'events:catalog (what CAN I wait on? — the awaitable-key registry; check before polling)',
      'deploy:await / work-item:await / … (named sugar for the common waits — build the key for you)',
      'events:emit (the counterpart — fire the event a peer awaits)',
      'events:cancel (retract a pending await)',
      'watch:create (a standing watch instead of a one-shot await)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: hardText(LIMITS.IDENT)
      .describe('Exact event key to wait on (string match — no globs).'),
    note: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Why you are waiting — echoed into the wake turn so resumed-you has the thread. Auto-truncated to 2000 chars if longer.'),
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
      note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
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
