/**
 * fleet:bench — bench a fleet member as TRACKED STATE
 * (fleet-reliability-verification-2026-07-10 P-006, EI-9000).
 *
 * Night-shift lesson this replaces (P-005's own repro, quoted on the plan
 * item): "leader could not trust emit alone for the phase3-open bench — one
 * member parked unregistered, one polled." The hand-written workaround was
 * per-member and easy to get half-right: the leader would ask a member to
 * "go events:await this key", trust they actually did, then ALSO
 * directed-wake each one as a belt-and-suspenders fallback because there was
 * no way to confirm the await landed. This tool makes benching something the
 * LEADER does centrally and can immediately verify, instead of something
 * each member does silently on their own:
 *
 *   fleet:bench { member, wakeEvent, stagedAssignment }
 *     → captures member's wake handle THIS moment (captureWakeHandleForOwner,
 *       the same D-003 capture events:await itself uses — just aimed at
 *       `member` instead of the caller) and registers the await FOR them,
 *       tagging the row's `note` with the staged assignment so it reads back
 *       as "why they're benched", not just a bare event key.
 *     → returns `registered: false` IMMEDIATELY when no resumable session was
 *       found for `member` — a bench miss caught at STAGE TIME, before the
 *       leader ever emits and finds out the hard way. Combined with
 *       events:emit's `waiters`/`woken` counts (P-005, already landed), the
 *       leader has miss-visibility at BOTH ends of a bench: whether it
 *       registered, and whether it actually fired.
 *   fleet:bench { list: true, fleet? }
 *     → the query half: who's benched on my fleet, on what key, with what
 *       staged leg. DERIVED, no new table (reuse-first) — this is exactly
 *       `listParkedAwaitsForSubscribers` (the same read fleet:assignments'
 *       `parkedOn` decoration already uses) filtered to bench-tagged rows and
 *       reshaped with the staged-assignment text restored from the note.
 *
 * A resolved bench (fired or cancelled) simply stops appearing in `list` —
 * the underlying event_awaits row is one-shot by construction (D-002), so
 * there is nothing to separately clean up.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { groupByAgent, listFleetAssignments } from '../../fleet/assignments';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait, listParkedAwaitsForSubscribers } from '../../events/await/store';
import { isPattern, expandPatternMacro, assertUsablePattern } from '../../events/await/pattern';
import { AWAIT_DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC } from '../../events/await/types';
import { hardText, softText, clampText, LIMITS } from '../limits';
import { readFleetLaneHealth } from '../../fleet/lane-health';

/** Tags a bench-staged await's `note` so `list` can pick it out from every
 *  OTHER reason an agent might hold an active await (a plain events:await, a
 *  lock wake_on_grant, …) sharing the same table. */
const BENCH_NOTE_PREFIX = '[fleet:bench] ';

/**
 * WI-5938 — PARK/PULL IS DERIVED STATE, NOT PROSE.
 *
 * The incident: a leader sent ONE message that both asserted the lane was live AND told
 * members to park. Park is correct only for a DRAINED lane; pull is correct for a live
 * one. The directive was self-contradictory, five members obeyed the park half, and they
 * idled beside a nonempty queue. `fleet:leader-brief` already knew better — it emits the
 * literal advice "DO NOT fleet:bench it either — the lane is not drained" — but that
 * advice was PROSE the leader had to read, remember and re-derive, while `fleet:bench`
 * itself would happily park anyone.
 *
 * So the invariant moves out of the leader's memory and into the tool: benching is for a
 * drained or blocked lane BY DEFINITION, and a bench against a member with claimable work
 * is not a judgement call the leader gets to make loosely — it is a contradiction. This
 * makes an incorrect bench IMPOSSIBLE by default rather than merely discouraged.
 *
 * Two deliberate design choices, both about failure direction:
 *
 *  1. UNKNOWN FAILS OPEN. `readFleetLaneHealth` returns `null` (never 0) when the count
 *     could not be read. A null must NOT refuse: that would let a transient spec/PG read
 *     error wedge every bench on the fleet, converting a read failure into a coordination
 *     outage. Refuse only on a number we actually have, and say so in the reply.
 *  2. GATED IS NOT DRAINED — BUT IT IS STILL BENCHABLE. `claimable === 0` with
 *     `matchedByFilter > 0` means the backlog exists but every row is behind a claim floor
 *     (EI-18689489507862177). That is precisely a BLOCKED lane, which is a legitimate
 *     reason to bench. The refusal therefore keys on `claimable > 0` — work the member
 *     could take RIGHT NOW — not on the mere existence of matching rows.
 *
 * `force: true` is the escape hatch, mirroring `work_items:claim`'s claim-hold bypass: a
 * leader with a genuine cross-lane reason (bench everyone until a migration lands) is not
 * wedged, but must ask for it deliberately, and the refusal detail is echoed back on the
 * response so the override is visible rather than silent.
 */
export interface BenchQueueVerdict {
  refuse: boolean;
  claimable: number | null;
  matchedByFilter: number | null;
  specRef: string | null;
  /** Why we did NOT refuse, when we did not — so a caller never reads silence as "drained". */
  reason: 'queue-nonempty' | 'drained' | 'gated' | 'unknown';
}

/** PURE: the whole park/pull decision, exported for direct unit-testing (no PG/DI). */
export function benchQueueVerdict(
  lane: { claimable: number; matchedByFilter: number; spec?: { ref?: string | null } } | null,
): BenchQueueVerdict {
  if (!lane) {
    // Fails OPEN — see (1) above. An unreadable count is not a drained lane, and it is
    // also not grounds to block the leader.
    return { refuse: false, claimable: null, matchedByFilter: null, specRef: null, reason: 'unknown' };
  }
  const specRef = lane.spec?.ref ?? null;
  if (lane.claimable > 0) {
    return {
      refuse: true,
      claimable: lane.claimable,
      matchedByFilter: lane.matchedByFilter,
      specRef,
      reason: 'queue-nonempty',
    };
  }
  return {
    refuse: false,
    claimable: lane.claimable,
    matchedByFilter: lane.matchedByFilter,
    specRef,
    // See (2) above: 0 claimable with rows still matching the filter is a GATED lane,
    // which is a blocked lane, which is a benchable lane — but the caller is told which
    // of the two it was, because the remedies are completely different.
    reason: lane.matchedByFilter > 0 ? 'gated' : 'drained',
  };
}

export interface BenchedMember {
  member: string;
  event: string;
  stagedAssignment: string | null;
  benchedAt: string;
  expiresTs: string | null;
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed). */
export function projectBenchRows(
  rows: ReadonlyArray<{ subscriberId: string; eventKey: string; note: string | null; expiresTs: string | null; createdAt: string }>,
): BenchedMember[] {
  return rows
    .filter((r) => typeof r.note === 'string' && r.note.startsWith(BENCH_NOTE_PREFIX))
    .map((r) => ({
      member: r.subscriberId,
      event: r.eventKey,
      stagedAssignment: (r.note as string).slice(BENCH_NOTE_PREFIX.length) || null,
      benchedAt: r.createdAt,
      expiresTs: r.expiresTs,
    }));
}

export default defineTool({
  name: 'fleet:bench',
  profile: 'engineer',
  description:
    "Bench a fleet member as TRACKED, queryable state instead of a hand-written per-member " +
    "convention. STAGE: fleet:bench { member, wakeEvent, stagedAssignment } captures the " +
    "member's wake handle and registers the events:await FOR them (note tagged with the " +
    "staged assignment) — returns `registered:false` immediately if no resumable session " +
    "was found for that member (a bench miss caught before you ever emit). LIST: " +
    "fleet:bench { list: true } (optionally { fleet }) returns who is benched on YOUR fleet, " +
    "on what key, with what staged leg. Pairs with events:emit's `waiters`/`woken` counts " +
    "(P-005) for miss-visibility at both stage time and emit time.",
  guidance: {
    when:
      "A leader staging a member's NEXT assignment while they wait on something (a watermark, " +
      "a peer's fix, a bench key) — instead of asking the member to events:await it themselves " +
      "and hoping it landed, or directed-waking everyone as a fallback because you can't tell " +
      "who actually registered. Also the query surface for 'who is benched on what right now'.",
    notWhen:
      "The member is awaiting something on their OWN initiative (they call events:await " +
      "directly). A one-off nudge — use coord:send / coord:wake. Fleet-wide health at a " +
      "glance — fleet:leader-brief already surfaces `parkedOn` per member.",
    chaining:
      "fleet:bench { member, wakeEvent, stagedAssignment } → (later) events:emit { event: " +
      "wakeEvent } wakes them, staged leg rides the wake note → fleet:bench { list: true } " +
      "any time to check current bench state.",
    returns:
      "STAGE mode REFUSES with { ok:false, error:'bench_refused_queue_nonempty' } when the " +
      "member's own lane still has claimable work (WI-5938): park is correct only for a " +
      'DRAINED or BLOCKED lane, pull is correct for a live one, and a leader message that ' +
      'asserts both is self-contradictory — five members once obeyed the park half and idled ' +
      'beside a nonempty queue. The refusal carries `claimable`, `matched_by_filter` and ' +
      '`spec_ref` so you can see the count and the exact scoping that produced it. Wake them ' +
      'to pull instead; pass { force: true } only for a genuine cross-lane hold (the override ' +
      'is echoed back as `forced` + `force_note`, never silent). Every successful bench also ' +
      "carries `lane.verdict`: 'drained' (0 claimable, 0 matching) | 'gated' (0 claimable but " +
      "rows matched — blocked, still benchable) | 'unknown' (the count could not be read, so " +
      'the guard failed OPEN rather than wedging the fleet on a read error) — never a ' +
      'zero-ish reading dressed up as a verified-empty queue.',
    seeAlso: [
      'events:await (a member self-registering, instead of the leader staging it for them)',
      'events:emit (fires the key — reports waiters/woken)',
      'fleet:leader-brief (whole-fleet health glance, including parkedOn)',
      'work_items:claimable (the excludedBreakdown behind a gated lane — read it before forcing)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    list: z
      .boolean()
      .optional()
      .describe('Query mode: return the current bench roster instead of staging a new one.'),
    fleet: z
      .string()
      .max(120)
      .optional()
      .describe("(list mode) Fleet slug to query. Defaults to the caller's own launch-env fleet."),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    member: hardText(LIMITS.IDENT)
      .optional()
      .describe('(stage mode) ownerId of the member being benched.'),
    wakeEvent: hardText(LIMITS.IDENT)
      .optional()
      .describe('(stage mode) Event key (or pattern — see events:await) that wakes this member.'),
    stagedAssignment: softText(LIMITS.ANNOTATION)
      .optional()
      .describe("(stage mode) What the member should pick up once woken — echoed on the wake and readable via { list: true }."),
    force: z
      .boolean()
      .optional()
      .describe(
        '(stage mode) Bench ANYWAY when the member\'s lane still has claimable work — the ' +
          'bench_refused_queue_nonempty override. For a genuine cross-lane hold (bench everyone ' +
          'until a migration lands), not for routine benching: the refused count is echoed back ' +
          'on the response so the override is visible rather than silent.',
      ),
    timeout_sec: z
      .number()
      .int()
      .positive()
      .max(AWAIT_MAX_TIMEOUT_SEC)
      .optional()
      .describe(`(stage mode) Deadline in seconds (default ${AWAIT_DEFAULT_TIMEOUT_SEC}) — the member is woken with a TIMEOUT marker if the key never fires.`),
  }),
  async handler(args, ctx) {
    // Resolved defensively (mirrors fleet:leader-brief): a read-mostly fleet
    // tool should still work for `list` even if identity resolution fails —
    // only stage mode's `benched_by` stamp genuinely needs `ownerId`.
    let actorWorkspace: string | null = null;
    let ownerId: string | undefined;
    try {
      const identity = resolveAgentIdentity(ctx);
      actorWorkspace = identity.workspaceId ?? null;
      ownerId = identity.ownerId;
    } catch {
      actorWorkspace = null;
    }

    if (args.list) {
      const fleet = args.fleet ?? deriveFleetMembership().fleetSlug;
      if (!fleet) {
        return {
          data: {
            ok: false,
            error: 'no_fleet',
            hint: "No fleet resolvable — pass { fleet: '<slug>' } explicitly.",
          },
        };
      }
      // EI-13820: ctx.workspaceId is the literal '*' sentinel for an unscoped su
      // session (EI-9013) — normalize through resolveConcreteWorkspaceId so '*'
      // never leaks into the workspace filter as if it were a real workspace id
      // (see fleet:assignments' handler for the full incident writeup).
      const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
      const rows = await listFleetAssignments({
        workspaceId,
        harness: args.harness,
        activeOnly: true,
      });
      const memberIds = groupByAgent(rows)
        .filter((g) => g.fleetSlug === fleet)
        .map((g) => g.agentId);
      const parked = memberIds.length > 0 ? await listParkedAwaitsForSubscribers(memberIds) : [];
      const benched = projectBenchRows(parked);
      return {
        data: {
          ok: true,
          fleet,
          benched_count: benched.length,
          benched,
        },
      };
    }

    if (!args.member || !args.wakeEvent) {
      return {
        data: {
          ok: false,
          error: 'missing_args',
          hint: 'Stage mode needs { member, wakeEvent, stagedAssignment }. Pass { list: true } to query instead.',
        },
      };
    }

    // WI-5938: park/pull is derived state — resolve it BEFORE staging anything, so a
    // refused bench never leaves a half-registered await behind.
    const benchFleet = args.fleet ?? deriveFleetMembership().fleetSlug;
    const laneHealth = benchFleet
      ? await readFleetLaneHealth({
          fleet: benchFleet,
          harness: args.harness,
          workspaceId: resolveConcreteWorkspaceId(args.workspace, actorWorkspace),
          // Scope the floors to the MEMBER being benched: their own held claims must not
          // count against them as an exclusion, or a member holding work would read as a
          // gated lane rather than a live one.
          assignee: args.member,
        })
      : null;
    const verdict = benchQueueVerdict(laneHealth);

    if (verdict.refuse && !args.force) {
      return {
        data: {
          ok: false,
          error: 'bench_refused_queue_nonempty',
          member: args.member,
          fleet: benchFleet,
          claimable: verdict.claimable,
          matched_by_filter: verdict.matchedByFilter,
          spec_ref: verdict.specRef,
          hint:
            `REFUSED: ${verdict.claimable} item(s) are claimable RIGHT NOW for ${args.member} under ` +
            `${verdict.specRef ?? 'this fleet\'s claim spec'}. Benching parks them next to work they ` +
            'should be pulling — the lane is not drained, so park is the wrong verb. Wake them to ' +
            'pull instead (coord:wake / scheduler:get_next). If the lane looks drained to you, the ' +
            "disagreement is the point: read work_items:claimable's excludedBreakdown under this " +
            'same spec before overriding. Genuine cross-lane hold? Re-send with { force: true }.',
          advice:
            'This is the WI-5938 invariant: fleet:bench is for a DRAINED or BLOCKED lane by ' +
            'definition. A leader message that both asserts the lane is live and tells members to ' +
            'park is self-contradictory — that contradiction is what this refusal makes impossible.',
        },
      };
    }

    const patternAwait = isPattern(args.wakeEvent);
    const eventKey = patternAwait ? expandPatternMacro(args.wakeEvent) : args.wakeEvent;
    if (patternAwait) assertUsablePattern(eventKey);

    const staged = clampText(args.stagedAssignment, LIMITS.ANNOTATION) ?? '';
    const { handle, note: handleNote } = await captureWakeHandleForOwner(args.member);

    const row = await registerAwait({
      subscriberId: args.member,
      eventKey,
      policy: 'wake',
      note: BENCH_NOTE_PREFIX + staged,
      wakeHandle: handle,
      timeoutBehavior: 'wake',
      timeoutSec: args.timeout_sec ?? AWAIT_DEFAULT_TIMEOUT_SEC,
    });

    return {
      data: {
        ok: true,
        bench_id: row.id,
        member: args.member,
        event: row.eventKey,
        ...(patternAwait ? { pattern: true } : {}),
        stagedAssignment: staged || null,
        expires_ts: row.expiresTs,
        registered: handle !== null,
        wake_handle_note: handleNote,
        benched_by: ownerId,
        // WI-5938: always report WHICH lane state justified the park, so a bench is never
        // just an assertion. 'unknown' is reported honestly rather than rendered as
        // 'drained' — the whole bug class here is a zero-ish reading standing in for a
        // verified-empty queue.
        lane: {
          verdict: verdict.reason,
          claimable: verdict.claimable,
          matched_by_filter: verdict.matchedByFilter,
          spec_ref: verdict.specRef,
        },
        ...(verdict.refuse && args.force
          ? {
              forced: true,
              force_note:
                `OVERRIDE: benched past ${verdict.claimable} claimable item(s) under ` +
                `${verdict.specRef ?? "this fleet's claim spec"} because { force: true } was passed. ` +
                'This member is now parked beside work it could have pulled.',
            }
          : {}),
        advice:
          handle !== null
            ? 'Benched. events:emit on this key will wake them; the staged assignment rides the wake note.'
            : `BENCH MISS at stage time: ${handleNote} — the await row exists but has no wake handle to re-invoke; emitting this key will not resume them. Confirm they have a live session before relying on this bench.`,
      },
    };
  },
});
