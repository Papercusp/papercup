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
import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, lookupByMcpName, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait, cancelAwait } from '../../events/await/store';
import { startAwaitSweeper, deliverToSpecificAwaits } from '../../events/await/engine';
import {
  PREDICATE_OPS,
  registerPredicateWatch,
  startPredicateWatchPoller,
  evalPredicateWatch,
  findMatchingActivePredicateWatch,
} from '../../events/await/predicate-watch';
import { activeWorkspaceId } from '../../workspace-registry';
import { subscribeTopic } from '../coordination/topics';
import { softText, clampText, LIMITS } from '../limits';

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): the one-shot wake default is now
// 30min, not 4h. Aliased to the local names so every usage below is unchanged.
import { AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC } from '../../events/await/types';

/** Default floor for a STANDING wake watch (once:false) — bounds the recurring-wake burn,
 *  generalized from the pot's floor. One-shot grants default to 0 (wake promptly). */
function standingWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_WATCH_MIN_SLEEP_SEC ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

export default defineTool({
  name: 'watch:create',
  description:
    'The unified subscription primitive — watch(pattern, {wake, once, min_sleep_sec, urgency, timeout_sec, mode}): register an interest, receive a delivery. DELIVERY — wake:false (DEFAULT, cheap) injects updates into your coord inbox (next natural turn, no token cost); wake:true (opt-in, a turn = tokens) re-invokes you when it fires. CARDINALITY — once:true is one-shot (auto-consumes — a grant); once:false is standing (re-fires per match). Sugar: events:await = watch(key,{wake:true,once:true}); topics:subscribe = watch(topic,{wake:false}). Lifecycle: events:cancel / events:status (wake) · topics:unsubscribe (inject). PREDICATE (wake:true): predicate:{tool,args,path,op,value}+interval_sec — the engine polls a read-only tool under YOUR role and wakes you on the false→true cross.',
  guidance: {
    when: 'Prefer wake:false (inject) for continuous awareness of a churning area — no cost. Use wake:true ONLY for specific readiness ("wake me when THIS grant/lock/deadline is ready"); for a standing wake watch set min_sleep_sec to bound the re-wake rate. once:true for a one-shot grant; once:false to keep following.',
    notWhen:
      'A sub-minute wait inside one turn — just do the bounded blocking call. A recurring TIME schedule — the pot/routines own time-based wakes. Ambient interest where a wake would burn turns — use wake:false.',
    chaining:
      'wake:true → end your turn; on wake the turn text carries the event + payload. events:cancel (wake) / topics:unsubscribe (inject) to stop; events:status to inspect your active wake watches + recent wakes.',
    seeAlso: [
      'events:await (a one-shot wait vs this standing watch)',
      'events:cancel (retract the watch)',
      'events:status (inspect your active watches)',
    ],
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
    note: softText(LIMITS.ANNOTATION).optional().describe('Why you are watching — echoed into the wake turn (wake:true). Auto-truncated to 2000 chars if longer.'),
    payload_filter: dataConditionSchema
      .optional()
      .describe(
        "EI-8998: a predicate tested against the emitted event's PAYLOAD (not just its key/pattern), e.g. { queue_depth: { lt: 5 } } — kills the polling-vigil pattern (\"wake me when X crosses a threshold\") without a bespoke exact key per condition. Same MatchMap/all/any/not vocabulary as an ECA rule's `when`. A filter that never matches the emitter's actual payload shape silently never fires — check the emitting source's payload shape first.",
      ),
    plan_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('wake:true from a plan run — the wake resumes the run via the plans:resume path instead of a session resume.'),
    predicate: z
      .object({
        tool: z.string().min(1).max(200).describe('READ-ONLY tool to poll, by mcp name (e.g. "work_items:list").'),
        args: z.record(z.string(), z.unknown()).optional().describe('Args passed on every poll.'),
        path: z.string().min(1).max(300).describe('Dot-path into the tool result, e.g. "counts.open" or "rows.0.status".'),
        op: z.enum(PREDICATE_OPS),
        value: z.unknown().optional().describe('Comparison operand (omit for exists).'),
      })
      .optional()
      .describe(
        'P-008 predicate watch (wake:true only): the engine polls `tool` every interval_sec UNDER YOUR ROLE (role gate enforced per poll, audited), extracts `path`, compares with `op` against `value`, and EDGE-fires your wake on the false→true cross. `pattern` becomes a label; the real key is synthetic (predicate:<id>). once:true deactivates after the first fire; once:false re-fires per cross. Registration runs ONE inline eval — a broken tool/role/args fails loudly NOW, and an already-true predicate fires immediately. DEDUPE (P-004): an IDENTICAL predicate (same scope/tool/args/path/op/value/interval_sec/once) already active JOINS that poller instead of starting a second one — response carries `deduped.joined_watch_id` when this happens.',
      ),
    interval_sec: z
      .number()
      .int()
      .min(15)
      .max(3600)
      .optional()
      .describe('Predicate poll cadence in seconds (predicate only; default 60).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const wake = args.wake ?? false;
    // Default cardinality follows delivery: a wake is a one-shot grant; an inject is standing.
    const once = args.once ?? wake;

    if (args.interval_sec != null && !args.predicate) {
      throw new Error('watch:create — interval_sec applies only to a predicate watch (for a wake floor, use min_sleep_sec).');
    }

    if (!wake) {
      // EI-8998: payload_filter is a wake-path-only feature today (it filters which
      // AWAIT rows fire; inject is a topic subscription with no per-emit fire/claim
      // step to hook it into) — fail loud rather than silently ignore it, so a caller
      // never believes an inject watch is predicate-filtered when it isn't.
      if (args.payload_filter) {
        throw new Error(
          'watch:create — payload_filter is only supported with wake:true today (it filters wake-await fires; a wake:false inject subscription has no per-emit matching step to apply it to).',
        );
      }
      // P-008: a predicate watch exists to FIRE A WAKE on a threshold cross — an
      // inject subscription has no await row to pair the poll with. Fail loud.
      if (args.predicate) {
        throw new Error(
          'watch:create — predicate requires wake:true (the engine-side poll fires a wake await on the false→true cross; there is no inject leg).',
        );
      }
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

    if (args.predicate) {
      // ── P-008 predicate watch: engine-side poll under the CALLER's role envelope. ──
      const p = args.predicate;
      const projected = lookupByMcpName(p.tool);
      if (!projected) {
        throw new Error(`watch:create — predicate.tool "${p.tool}" is not a known tool (use the mcp name, e.g. "work_items:list").`);
      }
      if (projected.effect !== 'read') {
        throw new Error(
          `watch:create — predicate.tool "${p.tool}" is not read-only (effect=${projected.effect ?? 'unset'}); a predicate poll may only observe, never mutate.`,
        );
      }
      startPredicateWatchPoller();
      const workspaceId = ctx.workspaceId ?? activeWorkspaceId();
      const role = ctx.role ?? 'su';
      const harnessSlug = ctx.harnessSlug ?? null;
      const intervalSec = args.interval_sec ?? 60;

      // EI-8998 dedup (fleet-reliability-verification-2026-07-10 P-004): join an
      // existing ACTIVE poller for the IDENTICAL predicate instead of starting a
      // second one — the motivating repro was two agents each independently polling
      // the same watermark SQL ~12+ times during the 2026-07-09/10 night shift.
      const existing = await findMatchingActivePredicateWatch({
        workspaceId,
        role,
        harnessSlug,
        tool: p.tool,
        args: p.args ?? {},
        path: p.path,
        op: p.op,
        value: p.value,
        intervalSec,
        once,
      });

      if (existing) {
        const row = await registerAwait({
          subscriberId: identity.ownerId,
          eventKey: existing.eventKey,
          policy: 'wake',
          note: clampText(args.note ?? `predicate: ${p.tool} ${p.path} ${p.op}`, LIMITS.ANNOTATION) ?? null,
          wakeHandle: handle,
          timeoutBehavior: args.on_timeout ?? 'wake',
          timeoutSec: args.timeout_sec ?? (once ? DEFAULT_TIMEOUT_SEC : null),
          once,
          minSleepSec,
          urgency: args.urgency,
          payloadFilter: null,
        });
        // The shared row only edge-fires on a false→true cross — a fresh join when
        // it's ALREADY true would otherwise never wake (no cross left to observe).
        // Deliver directly to THIS new await, without touching any other standing
        // subscriber already on the shared key.
        let fired = false;
        if (existing.lastEval === true) {
          const { delivered } = await deliverToSpecificAwaits({
            awaitRows: [row],
            payload: {
              observed: existing.lastValue,
              predicate: { tool: p.tool, path: p.path, op: p.op, value: p.value },
            },
            summary: `predicate already matched (joined existing poller ${existing.id}): ${p.tool} ${p.path} ${p.op}`,
            source: `predicate-watch:${identity.ownerId}`,
          });
          fired = delivered > 0;
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                watch: {
                  id: row.id,
                  pattern: existing.eventKey,
                  label: args.pattern,
                  wake: true,
                  once: row.once,
                  min_sleep_sec: row.minSleepSec,
                  urgency: row.urgency,
                  expires_ts: row.expiresTs,
                  on_timeout: row.timeoutBehavior,
                },
                predicate: { tool: p.tool, path: p.path, op: p.op, value: p.value, interval_sec: existing.intervalSec },
                deduped: { joined_watch_id: existing.id },
                first_eval: { matched: existing.lastEval === true, fired, observed: existing.lastValue },
                wake_handle: handleNote,
                advice: fired
                  ? 'Predicate is ALREADY true (joined an existing poller for the identical predicate) — the wake fired on this registration. End your turn; the delivery is on its way.'
                  : `Predicate registered — joined an EXISTING poller for the identical predicate (polled every ${existing.intervalSec}s under your role; no extra poller started). End your turn — you will be woken on the false→true cross${once ? ' exactly once' : ', each cross'} (or at the deadline). Do not poll.`,
              }),
            },
          ],
        };
      }

      const id = globalThis.crypto.randomUUID();
      const eventKey = `predicate:${id}`;
      // The await registers FIRST: the poller GCs any predicate row whose paired
      // await is gone, so the row must never exist without its waiter.
      const row = await registerAwait({
        subscriberId: identity.ownerId,
        eventKey,
        policy: 'wake',
        note: clampText(args.note ?? `predicate: ${p.tool} ${p.path} ${p.op}`, LIMITS.ANNOTATION) ?? null,
        wakeHandle: handle,
        timeoutBehavior: args.on_timeout ?? 'wake',
        timeoutSec: args.timeout_sec ?? (once ? DEFAULT_TIMEOUT_SEC : null),
        once,
        minSleepSec,
        urgency: args.urgency,
        payloadFilter: null,
      });
      const watchRow = await registerPredicateWatch({
        id,
        workspaceId,
        ownerId: identity.ownerId,
        role,
        harnessSlug,
        eventKey,
        tool: p.tool,
        args: p.args ?? {},
        path: p.path,
        op: p.op,
        value: p.value,
        intervalSec,
        once,
      });
      // ONE inline eval: validates the whole pipeline under the real envelope NOW,
      // and an already-true predicate fires immediately instead of one interval out.
      const first = await evalPredicateWatch(watchRow);
      if (first.error) {
        // A registration whose very first poll fails (role gate, bad args, tool
        // throw) will fail every poll — unwind both rows and fail LOUDLY now.
        await cancelAwait({ awaitId: Number(row.id), subscriberId: identity.ownerId });
        throw new Error(
          `watch:create — predicate registration failed its inline first eval (unwound): ${first.error}`,
        );
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              watch: {
                id: row.id,
                pattern: eventKey,
                label: args.pattern,
                wake: true,
                once: row.once,
                min_sleep_sec: row.minSleepSec,
                urgency: row.urgency,
                expires_ts: row.expiresTs,
                on_timeout: row.timeoutBehavior,
              },
              predicate: { tool: p.tool, path: p.path, op: p.op, value: p.value, interval_sec: watchRow.intervalSec },
              first_eval: { matched: first.matched, fired: first.fired, observed: first.observed },
              wake_handle: handleNote,
              advice: first.fired
                ? 'Predicate is ALREADY true — the wake fired on this registration. End your turn; the delivery is on its way.'
                : `Predicate registered (polled every ${watchRow.intervalSec}s under your role). End your turn — you will be woken on the false→true cross${once ? ' exactly once' : ', each cross'} (or at the deadline). Do not poll.`,
            }),
          },
        ],
      };
    }

    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: args.pattern,
      policy: 'wake',
      note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
      wakeHandle: handle,
      timeoutBehavior: args.on_timeout ?? 'wake',
      timeoutSec: args.timeout_sec ?? (once ? DEFAULT_TIMEOUT_SEC : null),
      once,
      minSleepSec,
      urgency: args.urgency,
      payloadFilter: args.payload_filter ?? null,
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
