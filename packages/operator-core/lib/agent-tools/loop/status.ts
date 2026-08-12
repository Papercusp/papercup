/**
 * loop:status — read the loop on your own session (or another owner's): is it
 * active, its interval, whether its turn is in flight (parked), the next/last
 * fire, and the cost-cap (loop-routines-interval-recurrence-2026-06-20, B-LOOP-5).
 * The targeted "observe a loop" read; fleet:assignments shows the work the loop
 * is creating, and the routine fire-history shows each wake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { describeStoreIdentityMismatch, storeIdentityViolation } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getLoopStatus } from '../../harness/routines/loop';
import {
  probeWakeReachability,
  type WakeReachabilityVerdict,
} from '../../events/await/wake-reachability';
import { listWakeAwaitsForSubscriber } from '../../events/await/store';
import type { LivePushChannels } from './arm';

export default defineTool({
  name: 'loop:status',
  profile: 'engineer',
  // P-011 prompt-weight budget counts description + when + notWhen + chaining
  // and NOT returns/seeAlso. The RESPONSE documentation below therefore lives in
  // `guidance.returns`: it was in `description`, which pushed this tool to 1568
  // chars and breached the 1500 budget, reddening the fleet gate (WI-9334). It is
  // documentation of the RESPONSE, so `returns` is also where it belongs — and it
  // is demand-loaded via tools:find rather than baked into every system prompt.
  description:
    "Inspect the loop on your own session (or another owner's, with `ownerId`); this read is owner-scoped and intentionally does not take a `harness` argument. It reports active?, interval, parked (turn in flight), next/last fire, and cost-cap. Three fields carry warnings you must read before acting — `turnsStalled` (armed but not producing), `pendingAwaits` (whether you are REALLY parked), and a `storeIdentityViolation` guard that makes a `null` mean UNKNOWN rather than \"no loop\": see `returns`.",
  guidance: {
    when: 'Check whether your loop is still armed + when it next fires, or inspect another agent\'s loop. Pass `ownerId` for another session; do not pass `harness` because this read is keyed by owner.',
    returns:
      "The loop record for the owner (active, intervalSec, parked, nextFireAt, lastFireAt, fireCount, firesSinceArm, cost-cap), or null when no loop exists.\n\nFields that change what you should DO:\n• `firesSinceArm` vs `maxFires` (WI-36070) — the ONLY valid dead-man comparison. `fireCount` is a LIFETIME counter and a re-arm resets the budget, so `fireCount > maxFires` on an active loop is the EXPECTED reading, not a breached bound. Comparing those two reports a healthy loop as already-halted, and hides a loop one fire from going silently inert (EI-19899671638499010).\n• `turnsStalled` (EI-18712914572668391) — true when fires keep landing (fireCount climbing) but `lastTurnAt` (the most recent real turn-completion marker) isn't keeping pace, e.g. a wedged wake channel. This is the armed-but-not-PRODUCING case: `stalled` alone only catches a PARKED in-flight turn stuck past its dwell window, so a loop can be firing on schedule and doing nothing while `stalled` stays false.\n• `storeIdentityViolation` (EI-19384072467112035) — a `null` loop alongside this block means the process was reading from the WRONG database when it looked. Treat that null as UNKNOWN, NOT as \"no loop\", and do NOT re-arm on the strength of it alone: re-arming on a misread is how a live loop gets duplicated.\n• `pendingAwaits` (EI-19415169477907694) — your OWN live non-inbox-wake events:await registrations right now, so \"am I actually parked?\" is answerable after a call whose response you never trust (a dropped MCP transport, a backgrounded/failed events:await). `status:'found'` with a sample of keys means a registration IS live; `status:'none'` means NOTHING is registered — the loud signal that a believed-successful await never actually landed; `status:'unknown'` means the lookup itself failed and must NEVER be read as 'none'.\n• Cadence (EI-20217869515819188) — compare `expectedFiresSinceArm` with `firesSinceArm` to see how many interval-sized opportunities elapsed versus attempted fires. `effectiveIntervalSec` and `cadenceRatio` expose a slow fire path (`cadenceRatio` > 1 means slower than configured; > 3 is a warning), and `longestObservedGapSec` reports the largest arm-scoped wake gap. A null cadence field means insufficient timestamps/history, never zero.",
    notWhen: 'See the WORK a loop is producing — that is fleet:assignments (the self-assigned work_items). Whole-engine health — autoloop:status.',
    chaining: 'loop:arm to start; loop:end to stop.',
    seeAlso: [
      'loop:arm (start a loop)',
      'loop:end (stop it)',
      'fleet:assignments (the work the loop is producing)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  // EI-20229292848756531: this read performs independent DB probes
  // (loop status, wake reachability, and pending awaits) and never consumes
  // ctx.tx. Do not hold the dispatcher's ambient org-app transaction across
  // those awaits; pool contention would make loop:status itself time out at
  // withWorkspace:acquire(app).
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe('Inspect the loop for this owner id (default: yourself). The status read is owner-scoped; `harness` is intentionally not an argument.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.ownerId ?? identity.ownerId;
    const status = await getLoopStatus(ownerId);

    // WI-655 — surface LIVE wake-reachability alongside the loop row: an active loop
    // whose owner can't receive a wake (the `no-session-now` black-hole) reads as a loud
    // `reachable:false` here rather than only as a stale lastDeliveryOutcome. Best-effort.
    let reachability: WakeReachabilityVerdict | null = null;
    if (status?.active) {
      reachability = await probeWakeReachability(ownerId).catch(() => null);
    }
    const reachabilityOut = reachability
      ? {
          reachable: reachability.reachable,
          channel: reachability.channel,
          durableWhileAlive: reachability.durableWhileAlive,
          summary: reachability.summary,
          ...(reachability.warning ? { warning: reachability.warning } : {}),
        }
      : null;

    // EI-19415169477907694: "am I actually parked?" — the caller's own live, non-inbox-wake
    // events:await registrations. Answers the exact filed failure: a dropped MCP transport
    // (or any await call whose response the caller cannot trust) can leave an agent believing
    // it registered a park when nothing was ever written. Run unconditionally (not gated on
    // loop.active) — an agent that never armed a loop and instead parked on a bare events:await
    // deserves this answer too. Best-effort + fail-soft, same discipline as reachability above
    // and as loop:arm's own use of this exact read (EI-19447204017443244): a lookup failure
    // must read as 'unknown', never collapse into 'none' (that would fabricate a measurement).
    let pendingAwaits: LivePushChannels = { status: 'unknown' };
    try {
      const awaits = await listWakeAwaitsForSubscriber(ownerId);
      pendingAwaits =
        awaits.length > 0
          ? { status: 'found', count: awaits.length, sample: awaits.slice(0, 5).map((a) => a.eventKey) }
          : { status: 'none' };
    } catch {
      /* best-effort — a lookup failure must read as 'unknown', never 'none' */
    }

    // EI-19384072467112035: a `loop: null` here is the documented "no loop exists" signal,
    // and an agent reading it correctly re-arms. But `getLoopStatus` reads through
    // `getOrgPg()`, which can (per plan outage-must-not-be-silent-2026-08-02) be talking to
    // a DIFFERENT, freshly-initdb'd store than the one this process pinned — in which case
    // "no row for this owner" is a correct answer from the WRONG database, not evidence the
    // loop is gone. Only checked on the null/negative path: a found row is trustworthy
    // regardless (a match against another store's data, by a snowflake-shaped owner id, is
    // not a realistic false positive), so this can never make a healthy `loop:null` noisier.
    // `storeIdentityViolation()` is non-null only after two successfully-read, genuinely
    // different cluster identities — never on a failed/absent probe — so it cannot fire
    // spuriously either. Mirrors dev:pg_health's delivery of the same guard (D-004: DETECT
    // already existed everywhere: the gap was always that nobody surfaced it where an agent
    // was actually looking).
    let storeIdentityWarning: {
      severity: 'critical';
      headline: string;
      whatThisMeans: string;
      detail: string;
    } | null = null;
    if (status === null) {
      const violation = storeIdentityViolation();
      if (violation) {
        storeIdentityWarning = {
          severity: 'critical',
          headline:
            'WRONG STORE — this null may not mean "no loop exists". This process has talked to a different database than the one it pinned.',
          whatThisMeans:
            'Do NOT treat this loop:null as "no loop is armed" and re-arm on its strength alone — that risks a duplicate loop if the real store (with the real loop row) becomes reachable again moments later. Re-check after confirming the store is healthy (dev:pg_health), or via fleet:assignments / coord:presence for corroborating signs the owner already has an active loop.',
          detail: describeStoreIdentityMismatch(violation.pinned, violation.observed),
        };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ownerId,
            loop: status,
            reachability: reachabilityOut,
            pendingAwaits,
            ...(storeIdentityWarning ? { storeIdentityWarning } : {}),
          }),
        },
      ],
    };
  },
});
