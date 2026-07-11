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
import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait, findAnnouncementsForKey, findNearMissKeys } from '../../events/await/store';
import { withBoundedTimeout } from '../../bounded-timeout';
import { startAwaitSweeper } from '../../events/await/engine';
import { isPattern, expandPatternMacro, assertUsablePattern } from '../../events/await/pattern';
import { liveBlockedState } from '../../work-items-events';
import { hardText, softText, clampText, LIMITS } from '../limits';

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): the default is now 30min, not 4h.
// Aliased to the local names so every usage/describe below is unchanged.
import { AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC } from '../../events/await/types';

export default defineTool({
  name: 'events:await',
  description:
    'Register a one-shot WAKE on an event key OR a key PATTERN. When it fires you are re-invoked, so end your turn instead of polling. A pattern (`work-item:done:*`, or the macros `@plan:<slug>` / `@fleet:<slug>`) wakes on the FIRST matching key — one await for "any lane item finished" instead of N.',
  guidance: {
    when: 'You are blocked on a known event key: a lock grant, plan run finishing, peer answer, deploy/gate landing, or a custom key another tool/agent will emit (patterns/macros cover whole families — see `event`). HAND-MINTED pair key? Have the completion\'s OWNER declare it first (events:emit { announce:true }) and await the RETURNED key — never re-type a key from a chat message (near-miss drift strands you). work-item:unblocked:<id> latches at registration: an already-unblocked target returns already_unblocked instead of a dead wait.',
    notWhen:
      'Ambient interest (use topics:subscribe), sub-minute waits inside one turn, or recurring schedules. Prefer the sugar verbs for common waits: deploy:await, checkpoint:await, work-item:await, service:await-up, git-sync:await, plan-item:await, fleet:await-drained.',
    chaining: 'events:catalog → events:await { event } (or a sugar verb) → END YOUR TURN → the wake carries the payload → re-register if you need the NEXT occurrence (one-shot: a fired await is gone). events:cancel retracts; events:status inspects.',
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
      .describe(
        'Event key to wait on. An EXACT key (`lock:grant:t1`) matches that one key. A PATTERN — a glob with `*` (`work-item:done:*`), or a macro `@plan:<slug>` (→ any plan item done) / `@fleet:<slug>` (→ any fleet event) — wakes on the FIRST key that matches. `*` matches any run of characters.',
      ),
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
    payload_filter: dataConditionSchema
      .optional()
      .describe(
        "EI-8998: also require the emitted PAYLOAD to satisfy this predicate before firing, e.g. { queue_depth: { lt: 5 } } — same vocabulary as an ECA rule's `when`. Only takes effect combined with an `event` key/pattern the emitter actually fires.",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    startAwaitSweeper();

    // ── Resolve the key: a PATTERN (glob / @macro) normalizes to a stored glob (P-201);
    //    an exact key passes through. A bad macro / too-broad glob throws a clear message. ──
    const patternAwait = isPattern(args.event);
    const eventKey = patternAwait ? expandPatternMacro(args.event) : args.event;
    if (patternAwait) assertUsablePattern(eventKey);

    // ── EI-9270: the announced-gate LATCH — if this exact key was DECLARED and has
    // ALREADY fired, say so NOW instead of registering a wait that can never fire
    // again (the await-after-emit race that stranded late joiners forever). A lapsed
    // declaration (fired_reason='expired') is NOT a latch. Best-effort read.
    let announcedGate: { note: string | null; announcedBy: string } | null = null;
    let nearMiss: Array<{ key: string; kind: 'await' | 'announce'; holders: number }> | null = null;
    if (!patternAwait) {
      try {
        const anns = await findAnnouncementsForKey(eventKey);
        const latched = anns.find((a) => a.firedAt && a.firedReason === 'event');
        if (latched) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  already_fired: true,
                  event: eventKey,
                  fired_at: latched.firedAt,
                  ...(latched.note ? { gate_note: latched.note } : {}),
                  advice: `The announced gate "${eventKey}" ALREADY FIRED at ${latched.firedAt} — do not wait. Proceed with the work this gate was blocking now.`,
                }),
              },
            ],
          };
        }
        const declared = anns.find((a) => !a.firedAt);
        if (declared) announcedGate = { note: declared.note, announcedBy: declared.subscriberId };
        // ── event-key-nearmiss-guard P-005: no announcement matches this key
        // exactly — advisory scan for a near-identical active key (another
        // agent's await, or a declared gate you almost-typed). Time-bounded +
        // fail-soft; the registration below always proceeds. ──
        if (anns.length === 0) {
          const found = await withBoundedTimeout(
            findNearMissKeys(eventKey, { excludeOwner: identity.ownerId }),
            { fallback: [], timeoutMs: 1_000, label: 'events-await:nearMiss' },
          );
          if (found.value.length > 0) {
            nearMiss = found.value.map((m) => ({ key: m.eventKey, kind: m.kind, holders: m.holders }));
          }
        }
      } catch { /* best-effort — never block a registration */ }
    }

    // ── linking-notify-family-hardening P-006: the unblocked-key LATCH.
    // `work-item:unblocked:<id>` fires only on a blocked→unblocked EDGE, so a
    // registration against an item with NO live blocker (or already settled)
    // could only ever time out — the await-after-the-fact strand, same class
    // as the EI-9270 announced-gate race above. Say so NOW. Best-effort and
    // time-bounded: an 'unknown' probe (unreadable item, ambiguous id) falls
    // through to a normal registration.
    const unblockedTarget = patternAwait ? undefined : /^work-item:unblocked:([^:]+)$/.exec(eventKey)?.[1];
    if (unblockedTarget) {
      const probe = await withBoundedTimeout(liveBlockedState(unblockedTarget), {
        fallback: 'unknown' as const,
        timeoutMs: 1_500,
        label: 'events-await:unblockedLatch',
      });
      if (probe.value === 'unblocked' || probe.value === 'settled') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_unblocked: true,
                event: eventKey,
                item_state: probe.value,
                advice:
                  probe.value === 'settled'
                    ? `${unblockedTarget} is already SETTLED — "${eventKey}" will never fire. Do not wait on it.`
                    : `${unblockedTarget} has NO live blocker right now — it is ALREADY unblocked, so "${eventKey}" will not fire (it fires only on a future blocked→unblocked edge). Proceed with the blocked work now instead of waiting.`,
              }),
            },
          ],
        };
      }
    }

    // ── Capture the wake handle NOW (D-003) ────────────────────────────
    const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
      planRunId: args.plan_run_id,
    });

    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey,
      policy: 'wake',
      note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
      wakeHandle: handle,
      timeoutBehavior: args.on_timeout ?? 'wake',
      timeoutSec: args.timeout_sec ?? DEFAULT_TIMEOUT_SEC,
      payloadFilter: args.payload_filter ?? null,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            await_id: row.id,
            event: row.eventKey,
            ...(patternAwait ? { pattern: true } : {}),
            ...(announcedGate ? { announced_gate: announcedGate } : {}),
            ...(nearMiss
              ? {
                  near_miss: nearMiss,
                  near_miss_advice: `No declaration matches "${eventKey}" exactly, but a near-identical key is active: "${nearMiss[0].key}" (${nearMiss[0].kind}). If you meant that key, events:cancel this await and re-await it EXACTLY — normalized-near keys never rendezvous.`,
                }
              : {}),
            expires_ts: row.expiresTs,
            on_timeout: row.timeoutBehavior,
            wake_handle: handleNote,
            advice: patternAwait
              ? `Registered a PATTERN await on "${row.eventKey}". End your turn now — you will be re-invoked when the FIRST matching key fires (or at the deadline). It is one-shot: re-register if you need to wake on the next match too. Do not poll.`
              : 'Registered. End your turn now — you will be re-invoked when the event fires (or at the deadline). Do not poll.',
          }),
        },
      ],
    };
  },
});
