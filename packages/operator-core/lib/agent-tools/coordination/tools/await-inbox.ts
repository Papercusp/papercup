/**
 * coord:await-inbox — the idle-agent wake scaffold
 * (local-hive-orchestration-2026-06-06 Phase 4: P-041, D-005).
 *
 * When an agent ends a turn idle (its work-list is drained / it is awaiting
 * direction) it calls this ONCE, then ends its turn. This registers a STANDING
 * wake watch on the agent's OWN inbox-wake key — the rendezvous a later
 * `coord:send {wake:true, to:[me]}` fires (P-040). The agent then sleeps and is
 * re-invoked exactly when work/direction is sent to it.
 *
 * It is pure SUGAR over the shipped watch primitive — the same registration as
 * `watch:create { pattern: inboxWakeKey(self), wake:true, once:false,
 * min_sleep_sec }` — with the pattern fixed to the caller's own inbox-wake key
 * so a bee never has to know/type the key convention. It does NOT build a second
 * wake pump; the floor + coalesce + the liveness re-invoke ladder (incl. the
 * `claude --resume` path proven live in unify-watch) all come from
 * events/await/engine.
 *
 * `once:false` (standing) is deliberate: a bee may be woken, drain the new work,
 * go idle again, and be woken anew — the same watch keeps catching sends without
 * re-registering. The `min_sleep_sec` floor bounds the re-wake burn if a Queen
 * fires several sends in a burst (they coalesce into one wake).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { inboxWakeKey } from '../inbox-wake';
import { captureWakeHandleForOwner } from '../../../events/await/handle';
import { registerAwait } from '../../../events/await/store';
import { startAwaitSweeper } from '../../../events/await/engine';

/** Standing inbox-wake floor (seconds): bursts of sends inside this window
 *  coalesce into one wake. Shares the watch primitive's env knob so the two
 *  surfaces stay in lockstep. */
function idleWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_WATCH_MIN_SLEEP_SEC ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

export default defineTool({
  name: 'coord:await-inbox',
  description:
    'Idle end-of-turn scaffold: register a STANDING wake watch on YOUR OWN inbox so a later coord:send {wake:true} to you re-invokes you, then end your turn (sleep). Call this exactly when your work-list is drained / you are awaiting direction — not while you still have work. Sugar over watch:create on your inbox-wake key (the deliver-and-wake rendezvous). Returns the watch id + your inbox-wake key.',
  guidance: {
    when: 'You are idle at end-of-turn — work-list empty or blocked, awaiting the Queen / a peer to send you something. Register the watch, then END YOUR TURN. You are re-invoked when work/direction arrives via coord:send {wake:true}.',
    notWhen:
      'You still have queued work — keep going. A specific one-shot readiness (a lock grant, a peer\'s artifact) — use events:await on that exact key. A sub-minute wait inside one turn — just block.',
    chaining:
      'coord:await-inbox → end your turn. On wake the turn text carries the message that woke you (read coord:inbox for the full set). To stop watching: events:cancel.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    note: z
      .string()
      .max(300)
      .optional()
      .describe('Why you are idle / what you are waiting for — echoed into the wake turn.'),
    min_sleep_sec: z
      .number()
      .int()
      .nonnegative()
      .max(7 * 24 * 60 * 60)
      .optional()
      .describe(
        'Per-subscriber wake floor: never re-wake within this window; a burst of sends inside it coalesces into ONE wake. Default: a sane standing floor.',
      ),
    plan_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('If you are a plan run, the wake resumes the run via plans:resume instead of a session resume.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const key = inboxWakeKey(identity.ownerId);

    startAwaitSweeper();
    const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
      planRunId: args.plan_run_id,
    });
    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: key,
      policy: 'wake',
      note: args.note ?? 'idle — awaiting work/direction (deliver-and-wake)',
      wakeHandle: handle,
      // Standing: keep catching sends across idle→woken→idle cycles without re-arming.
      once: false,
      minSleepSec: args.min_sleep_sec ?? idleWakeFloorSec(),
      workspaceId: identity.workspaceId ?? undefined,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            watch: {
              id: row.id,
              pattern: row.eventKey,
              wake: true,
              once: row.once,
              min_sleep_sec: row.minSleepSec,
            },
            inbox_wake_key: key,
            wake_handle: handleNote,
            advice:
              'Standing inbox-wake watch armed. END YOUR TURN now — you will be re-invoked when someone coord:sends you with {wake:true} (bursts coalesce into one wake). Do not poll.',
          }),
        },
      ],
    };
  },
});
