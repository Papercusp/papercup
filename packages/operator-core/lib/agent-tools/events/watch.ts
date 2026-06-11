/**
 * watch — the unified subscription primitive (unify-watch-primitive-2026-06-06 P-007).
 *
 * `events:await` and `topics:subscribe` are the same act — register an interest, receive
 * a delivery — that differ on exactly two axes: CARDINALITY (`once`: one-shot vs standing)
 * and DELIVERY (`wake`: re-invoke me as a fresh turn vs inject into my inbox for my next
 * natural turn). `watch(pattern, {wake, once, min_sleep_sec, urgency, deadline})` is the one
 * registration with those as knobs; the two named tools survive as thin sugar presets (D-007):
 *
 *   events:await {key}      = watch(key,   {wake:true,  once:true})
 *   topics:subscribe {topic}= watch(topic, {wake:false, once:false})
 *
 * Routing (D-002 — inject is the cheap default; wake is the deliberate opt-in):
 *   - `wake:false` → the inject path (a standing topic subscription → coord inbox; no token cost).
 *   - `wake:true`  → the wake path (the durable liveness-adaptive re-invoke ladder), with the
 *     per-subscriber floor + burst-coalesce applied (a standing wake watch is bounded, not a
 *     ~30s re-wake storm). `once:true` carries the exactly-once + atomic-fire + wake-handle-at-
 *     registration grant guarantee (D-004).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait } from '../../events/await/store';
import { startAwaitSweeper } from '../../events/await/engine';
import { subscribeTopic } from '../coordination/topics';

const DEFAULT_TIMEOUT_SEC = 4 * 60 * 60; // 4h (one-shot wake default)
const MAX_TIMEOUT_SEC = 7 * 24 * 60 * 60; // 7d

/** Default floor for a STANDING wake watch (once:false) — bounds the recurring-wake burn,
 *  generalized from the pot's floor. One-shot grants default to 0 (wake promptly). */
function standingWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_WATCH_MIN_SLEEP_SEC ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

export default defineTool({
  name: 'watch:create',
  description:
    'The unified subscription primitive — watch(pattern, {wake, once, min_sleep_sec, urgency, timeout_sec, mode}): register an interest, receive a delivery. DELIVERY — wake:false (DEFAULT, cheap) injects updates into your coord inbox (seen on your next natural turn, no token cost); wake:true (opt-in, a turn = tokens) re-invokes you when it fires. CARDINALITY — once:true is one-shot (fires once, auto-consumes — a grant/readiness); once:false is standing (re-fires on every match). Named sugar presets: `events:await {key}` = watch(key,{wake:true,once:true}); `topics:subscribe {topic}` = watch(topic,{wake:false}). Lifecycle: events:cancel / events:status (wake) · topics:unsubscribe (inject).',
  guidance: {
    when: 'Register interest in something and receive its updates. Prefer wake:false (inject) for continuous awareness of a churning area — no cost. Use wake:true ONLY for specific readiness ("wake me when THIS grant/lock/deadline is ready"); for a standing wake watch set min_sleep_sec to bound the re-wake rate. once:true for a one-shot grant; once:false to keep following.',
    notWhen:
      'A sub-minute wait inside one turn — just do the bounded blocking call. A recurring TIME schedule — the pot/routines own time-based wakes. Ambient interest where a wake would burn turns — use wake:false.',
    chaining:
      'wake:true → end your turn; on wake the turn text carries the event + payload. events:cancel (wake) / topics:unsubscribe (inject) to stop; events:status to inspect your active wake watches + recent wakes.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    pattern: z
      .string()
      .min(1)
      .max(200)
      .describe('What to watch: an exact event key (wake) or a topic slug (inject). Exact match.'),
    wake: z
      .boolean()
      .optional()
      .describe(
        'Delivery mode. false (DEFAULT) = inject into your inbox (cheap, seen next turn). true = re-invoke you (a turn = tokens) — opt-in, for specific readiness only.',
      ),
    once: z
      .boolean()
      .optional()
      .describe(
        'Cardinality. Default follows wake (one-shot for a wake grant; standing for an inject subscription). true = fires once then clears; false = standing (re-fires).',
      ),
    min_sleep_sec: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TIMEOUT_SEC)
      .optional()
      .describe(
        'Per-subscriber wake floor (wake:true only): never re-wake you within this window; a burst inside it coalesces into ONE wake. Default: a sane floor for a standing watch, 0 (no floor — wake promptly) for a one-shot grant.',
      ),
    urgency: z
      .boolean()
      .optional()
      .describe('This watch’s wakes always bypass the floor (a human-message / escalation watch).'),
    timeout_sec: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_SEC)
      .optional()
      .describe('Deadline. wake:true → see on_timeout (default 4h for a one-shot). wake:false → auto-drops the subscription (TTL).'),
    on_timeout: z
      .enum(['wake', 'expire'])
      .optional()
      .describe('wake:true only — at the deadline without the event: wake (default — a TIMEOUT marker) or expire (silent lapse, visible in events:status).'),
    mode: z
      .enum(['full', 'digest', 'mention'])
      .optional()
      .describe('wake:false only — inject delivery tiering: full (default), digest (high-churn), mention (the quiet floor).'),
    note: z.string().max(300).optional().describe('Why you are watching — echoed into the wake turn (wake:true).'),
    plan_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('wake:true from a plan run — the wake resumes the run via the plans:resume path instead of a session resume.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const wake = args.wake ?? false;
    // Default cardinality follows delivery: a wake is a one-shot grant; an inject is standing.
    const once = args.once ?? wake;

    if (!wake) {
      // ── Inject preset (D-002 cheap default) → a standing topic subscription. ──
      const sub = await subscribeTopic(identity, args.pattern, { mode: args.mode, ttl_sec: args.timeout_sec });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              watch: {
                pattern: sub.target_ref,
                wake: false,
                once: false,
                mode: sub.delivery_mode,
                expires_ts: sub.expires_ts,
              },
              advice: 'Watching (inject). Updates land in your coord inbox — you will see them on your next turn, no token cost.',
            }),
          },
        ],
      };
    }

    // ── Wake preset → the durable re-invoke ladder, floored + coalesced. ──
    startAwaitSweeper();
    const minSleepSec = args.min_sleep_sec ?? (once ? 0 : standingWakeFloorSec());
    const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
      planRunId: args.plan_run_id,
    });
    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: args.pattern,
      policy: 'wake',
      note: args.note ?? null,
      wakeHandle: handle,
      timeoutBehavior: args.on_timeout ?? 'wake',
      timeoutSec: args.timeout_sec ?? (once ? DEFAULT_TIMEOUT_SEC : null),
      once,
      minSleepSec,
      urgency: args.urgency,
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
              urgency: row.urgency,
              expires_ts: row.expiresTs,
              on_timeout: row.timeoutBehavior,
            },
            wake_handle: handleNote,
            advice: once
              ? 'Registered a one-shot wake. End your turn now — you will be re-invoked exactly once when it fires (or at the deadline). Do not poll.'
              : 'Registered a standing wake watch (floored). End your turn — you will be re-woken on matches, at most once per min_sleep_sec, with bursts coalesced into one wake.',
          }),
        },
      ],
    };
  },
});
