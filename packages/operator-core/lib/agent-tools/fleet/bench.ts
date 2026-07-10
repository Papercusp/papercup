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
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { groupByAgent, listFleetAssignments } from '../../fleet/assignments';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait, listParkedAwaitsForSubscribers } from '../../events/await/store';
import { isPattern, expandPatternMacro, assertUsablePattern } from '../../events/await/pattern';
import { AWAIT_DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC } from '../../events/await/types';
import { hardText, softText, clampText, LIMITS } from '../limits';

/** Tags a bench-staged await's `note` so `list` can pick it out from every
 *  OTHER reason an agent might hold an active await (a plain events:await, a
 *  lock wake_on_grant, …) sharing the same table. */
const BENCH_NOTE_PREFIX = '[fleet:bench] ';

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
    seeAlso: [
      'events:await (a member self-registering, instead of the leader staging it for them)',
      'events:emit (fires the key — reports waiters/woken)',
      'fleet:leader-brief (whole-fleet health glance, including parkedOn)',
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
      const workspaceId = args.workspace ?? actorWorkspace ?? activeWorkspaceId();
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
        advice:
          handle !== null
            ? 'Benched. events:emit on this key will wake them; the staged assignment rides the wake note.'
            : `BENCH MISS at stage time: ${handleNote} — the await row exists but has no wake handle to re-invoke; emitting this key will not resume them. Confirm they have a live session before relying on this bench.`,
      },
    };
  },
});
