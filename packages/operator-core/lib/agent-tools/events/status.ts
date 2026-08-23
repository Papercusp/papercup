/**
 * events:status — your active awaits + recent wake deliveries + the wake meter
 * (await-event-primitive-2026-06-05 P-003/P-005, D-007).
 *
 * The meter half is the cost-discipline window: every wake is a turn, so
 * per-agent wake counts (by status + channel, last 24h) make a wake-storm
 * visible immediately.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { inspectEventKey, listActiveAwaits, listRecentDeliveries, wakeMeter } from '../../events/await/store';
import type { KeyFireRow } from '../../events/await/types';
import { listActiveComposedRoots, loadTreeLeaves } from '../../events/await/compose-store';
import { payloadMatchesFilter } from '../../events/await/pattern';
import type { AwaitRow } from '../../events/await/types';

type ExpectedCondition =
  | { kind: 'sha'; sha: string }
  | { kind: 'predicate'; predicate: unknown };

function announcementState(row: AwaitRow): 'declared' | 'fired' | 'cancelled' | 'expired' | 'superseded' {
  if (row.supersededAt) return 'superseded';
  if (row.cancelledAt) return 'cancelled';
  if (row.firedReason === 'expired') return 'expired';
  if (row.firedAt) return 'fired';
  return 'declared';
}

/**
 * EI-13705: the top-level `current_state` an agent actually reads. Previously this
 * came ONLY from the announce-policy declaration history, so a key that was fired via
 * a bare `events:emit` (no `announce:true`) read as `undeclared` FOREVER — identical to
 * a key that has never fired at all — once its waiter/delivery rows aged out of view.
 * That false-negative cost a real 7-day stall (see the bug writeup). The unconditional
 * fire latch (harness_shared.event_key_fires, migration 632) now backstops this: when
 * there is no active (non-superseded) announcement but the key HAS genuinely fired,
 * report `fired_undeclared` instead of `undeclared` so a reader can never again mistake
 * "nobody bothered to check the discovery box" for "this never happened".
 */
function currentState(
  currentAnnouncement: AwaitRow | null,
  fireLatch: KeyFireRow | null,
): 'declared' | 'fired' | 'cancelled' | 'expired' | 'superseded' | 'fired_undeclared' | 'undeclared' {
  if (currentAnnouncement) return announcementState(currentAnnouncement);
  if (fireLatch) return 'fired_undeclared';
  return 'undeclared';
}

function payloadSha(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  for (const key of ['sha', 'commitSha', 'commit_sha', 'deployedSha', 'deployed_sha', 'testedSha', 'tested_sha']) {
    if (typeof p[key] === 'string') return p[key].toLowerCase();
  }
  return null;
}

function expectedVerdict(row: AwaitRow): 'not-declared' | 'pending' | 'matched' | 'mismatched' | 'invalid' {
  if (row.expectedCondition == null) return 'not-declared';
  if (!row.firedAt) return 'pending';
  const expected = row.expectedCondition as Partial<ExpectedCondition> & Record<string, unknown>;
  if (expected.kind === 'sha' && typeof expected.sha === 'string') {
    const actual = payloadSha(row.firedPayload);
    return actual != null && actual === expected.sha.toLowerCase() ? 'matched' : 'mismatched';
  }
  if (expected.kind === 'predicate' && expected.predicate != null) {
    return payloadMatchesFilter(expected.predicate, row.firedPayload) ? 'matched' : 'mismatched';
  }
  return 'invalid';
}

export default defineTool({
  name: 'events:status',
  description:
    'Inspect the await-event surface: your active awaits/trees/recent wakes, or pass an exact event key for its declaration generations, expected condition, waiter registrations, wake outcomes, and a deterministic watermark/resync verdict. Optionally include the fleet-wide wake meter.',
  guidance: {
    when: 'Checking what you are (still) waiting on, whether a wake fired and via which channel, or whether the fleet is wake-storming (meter: true).',
    notWhen: 'Reading your message stream — that is coord:inbox. Following an area — topics:feed.',
    seeAlso: [
      'events:cancel (cancel an await you found here)',
      'events:await (arm a new wait)',
      'coord:inbox (your message stream, not the event registry)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    meter: z.boolean().optional().describe('Include the wake meter (per-agent counts by status/channel, 24h; events:await is single-workspace by design, so this is fleet-wide, not scoped to your workspace).'),
    event: z.string().min(1).max(200).optional().describe('Exact event key to inspect across declarations, waiter registrations, and wake outcomes.'),
    after_generation: z.number().int().nonnegative().optional().describe('Your cached declaration generation for `event`. The response says whether it is stale and how to resync.'),
  }),
  async handler(args, ctx) {
    if (args.after_generation != null && !args.event) {
      throw new Error('events:status — after_generation requires an exact `event` key.');
    }
    const identity = resolveAgentIdentity(ctx);
    // Exact-key inspection is an authority read for one event.  Do not spend
    // the result budget rendering this caller's unrelated await tree first —
    // under a busy fleet that list can hide the only requested evidence.
    const exactEvent = args.event != null;
    const [awaits, recent, meter, composedRoots, eventHistory] = await Promise.all([
      exactEvent ? Promise.resolve([]) : listActiveAwaits(identity.ownerId),
      exactEvent ? Promise.resolve([]) : listRecentDeliveries(identity.ownerId, 10),
      args.meter ? wakeMeter() : Promise.resolve(null),
      exactEvent ? Promise.resolve([]) : listActiveComposedRoots(identity.ownerId),
      args.event ? inspectEventKey(args.event) : Promise.resolve(null),
    ]);
    // Render each active composed tree: its authored spec + which leaves have fired vs.
    // are still pending. loadTreeLeaves reads a tree's leaves across all its nodes.
    const composed = await Promise.all(
      composedRoots.map(async (root) => ({
        root_id: root.id,
        spec: root.spec,
        required: root.requiredCount,
        fired_count: root.firedCount,
        expires_ts: root.expiresTs,
        on_timeout: root.timeoutBehavior,
        note: root.note,
        leaves: (await loadTreeLeaves(root.id)).map((l) => ({
          event: l.eventKey,
          fired: l.memberFiredAt != null,
          member_fired_at: l.memberFiredAt,
        })),
      })),
    );
    const currentAnnouncement = eventHistory?.announcements.find((a) => !a.supersededAt) ?? null;
    const fireLatch = eventHistory?.fireLatch ?? null;
    const authoritativeGeneration = currentAnnouncement?.causalGeneration ?? null;
    const resyncRequired = args.after_generation != null && args.after_generation !== authoritativeGeneration;
    const resyncReason = args.after_generation == null
      ? 'watermark_not_supplied'
      : authoritativeGeneration == null
        ? 'no_current_declaration'
        : args.after_generation < authoritativeGeneration
          ? 'consumer_behind'
          : args.after_generation > authoritativeGeneration
            ? 'consumer_ahead'
            : 'in_sync';
    const eventInspection = eventHistory
      ? {
          event: args.event,
          current_generation: authoritativeGeneration,
          current_state: currentState(currentAnnouncement, fireLatch),
          ...(fireLatch
            ? {
                fire_latch: {
                  first_fired_at: fireLatch.firstFiredAt,
                  last_fired_at: fireLatch.lastFiredAt,
                  last_fired_by: fireLatch.lastFiredBy,
                  fire_count: fireLatch.fireCount,
                },
              }
            : {}),
          ...(!currentAnnouncement && fireLatch
            ? {
                advice: `This key has genuinely fired ${fireLatch.fireCount}× (most recently ${fireLatch.lastFiredAt}${fireLatch.lastFiredBy ? ` by ${fireLatch.lastFiredBy}` : ''}) but was never declared via events:emit { announce:true } — do NOT read current_state:'fired_undeclared' as "never happened". If you were about to conclude this gate never opened, it did; check waiters[]/wake_outcomes[] below or last_fired_at for when.`,
              }
            : {}),
          declarations: eventHistory.announcements.map((a) => ({
            generation: a.causalGeneration ?? null,
            state: announcementState(a),
            declared_at: a.createdAt,
            declared_by: a.subscriberId,
            note: a.note,
            expected: a.expectedCondition ?? null,
            expected_verdict: expectedVerdict(a),
            actual_sha: payloadSha(a.firedPayload),
            fired_at: a.firedAt,
            fired_by: a.firedBy ?? null,
            cancelled_at: a.cancelledAt,
            superseded_at: a.supersededAt ?? null,
          })),
          waiters: eventHistory.waiters.map((a) => ({
            await_id: a.id,
            subscriber_id: a.subscriberId,
            policy: a.policy,
            state: a.cancelledAt ? 'cancelled' : a.firedAt ? (a.firedReason === 'expired' ? 'expired' : 'fired') : 'registered',
            registered_at: a.createdAt,
            fired_at: a.firedAt,
            fired_reason: a.firedReason,
            cancelled_at: a.cancelledAt,
            expires_ts: a.expiresTs,
          })),
          wake_outcomes: eventHistory.deliveries.map((d) => ({
            delivery_id: d.id,
            subscriber_id: d.subscriberId,
            status: d.status,
            channel: d.channel,
            attempts: d.attempts,
            source: d.source,
            last_error: d.lastError,
            created_at: d.createdAt,
            delivered_at: d.deliveredAt,
          })),
          resync: {
            required: resyncRequired,
            reason: resyncReason,
            consumer_generation: args.after_generation ?? null,
            authoritative_generation: authoritativeGeneration,
            rule: 'Replace cached state with this exact-key snapshot whenever required=true; then persist authoritative_generation as the next watermark.',
            next_verb: authoritativeGeneration == null
              ? `events:status { event: "${args.event}" }`
              : `events:status { event: "${args.event}", after_generation: ${authoritativeGeneration} }`,
          },
        }
      : null;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ...(exactEvent
              ? {}
              : {
                  // Plain awaits only — a composed tree's leaves + anchor (rootId set)
                  // render under composed_awaits below, not as loose rows here.
                  active_awaits: awaits
                    .filter((a) => a.rootId == null)
                    .map((a) => ({
                      await_id: a.id,
                      event: a.eventKey,
                      policy: a.policy,
                      note: a.note,
                      expires_ts: a.expiresTs,
                      on_timeout: a.timeoutBehavior,
                      created_at: a.createdAt,
                    })),
                  ...(composed.length > 0 ? { composed_awaits: composed } : {}),
                  recent_wakes: recent.map((d) => ({
                    delivery_id: d.id,
                    event: d.eventKey,
                    status: d.status,
                    channel: d.channel,
                    attempts: d.attempts,
                    last_error: d.lastError,
                    created_at: d.createdAt,
                    delivered_at: d.deliveredAt,
                  })),
                }),
            ...(meter ? { meter } : {}),
            ...(eventInspection ? { event_inspection: eventInspection } : {}),
          }),
        },
      ],
    };
  },
});
