/**
 * fleet:respawn-member — a fleet LEADER changes ONE member's BOOT-BAKED settings by draining +
 * relaunching it (per-member-declarative-launch-specs P-008, D-003). Boot-baked settings
 * (model / effort / account / contextSize / agent / compactionLimit) are fixed at process launch —
 * a running session cannot change them (unlike the runtime settings fleet:reconfigure-member
 * adjusts in place). So a respawn KILLS the old session (graceful SIGTERM via fleet:kill, releasing
 * its claims) and FRESH-LAUNCHES a replacement into the SAME fleet with the new declarative
 * MemberSpec (capability:launch-agent), which inherits the fleet's claim lane and mints a new
 * identity — one tool instead of a hand-rolled kill + relaunch.
 *
 * Scope: this routes the relaunch through capability:launch-agent (the headless-fleet-member door
 * the fleet already uses), so `carry` / `claimKinds` — which only fleet:launch-on-plan honors — are
 * NOT settable here (use fleet:reconfigure-member for the claim lane; fleet:launch-on-plan for a
 * carry change). Member resolution + leader/queen/owner auth are the shared resolveFleetMemberTarget.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { MemberSpec } from '../../agent-launch-core';
import killTool from '../fleet/kill';
import launchTool from '../capability/launch-agent';
import { resolveFleetMemberTarget } from './member-target';
import { listFleetPresence, type FleetPresenceRow } from '../coordination/presence-fleet';
import { json, ROUTING_LADDER } from './_shared';
import { resolveSavedFleetLaunchSpec } from './saved-launch-spec';

/** Default window to wait for the replacement's FIRST heartbeat before calling the respawn failed. */
const DEFAULT_VERIFY_SEC = 90;
const VERIFY_POLL_MS = 3_000;
/** A presence row counts as the live replacement only if its heartbeat is this fresh. */
const VERIFY_FRESH_MS = 120_000;

export interface AwaitReplacementResult {
  verified: boolean;
  newMemberOwnerId: string | null;
  waitedMs: number;
  /** Owners seen in the fleet at the end of the wait — the evidence behind a `false`. */
  rosterOwnerIds: string[];
}

/**
 * Wait for a NEW live member to appear in the fleet's presence roster after a launch.
 *
 * Why this exists (EI: fleet:respawn-member false success): capability:launch-agent returns
 * as soon as it has spawned the member's TERMINAL, and the terminal's launch script ends in
 * `exec "$SHELL" -l` — so when the agent CLI dies before its first turn (an exhausted account
 * pool, a bad model spec, a missing credential) you are left with a live pid, a live terminal,
 * and NO agent, while the launcher reports success. An agent that actually booted writes a
 * coord_presence row; nothing else does. So the roster is the only sound oracle, and a respawn
 * that cannot observe one must report failure rather than inherit the launcher's optimism.
 *
 * All IO is injected so this unit-tests without PG or real time.
 */
export async function awaitReplacementMember(opts: {
  before: Set<string>;
  list: () => Promise<FleetPresenceRow[]>;
  timeoutMs: number;
  intervalMs?: number;
  freshMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AwaitReplacementResult> {
  const {
    before,
    list,
    timeoutMs,
    intervalMs = VERIFY_POLL_MS,
    freshMs = VERIFY_FRESH_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;
  const startedAt = now();
  // Bound the loop by ITERATIONS as well as by the clock: the deadline test alone spins forever if
  // `now` ever fails to advance, and a tool call that never returns is a worse failure than a
  // slightly early give-up.
  const maxPolls = Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 2;
  let rosterOwnerIds: string[] = [];
  for (let poll = 0; ; poll += 1) {
    let rows: FleetPresenceRow[] = [];
    try {
      rows = await list();
    } catch {
      // A transient read failure is not evidence either way — keep polling until the deadline.
    }
    rosterOwnerIds = rows.map((r) => r.ownerId);
    const at = now();
    const fresh = rows.find(
      (r) => !before.has(r.ownerId) && at - new Date(r.heartbeatAt).getTime() <= freshMs,
    );
    if (fresh) {
      return { verified: true, newMemberOwnerId: fresh.ownerId, waitedMs: at - startedAt, rosterOwnerIds };
    }
    if (at - startedAt + intervalMs > timeoutMs || poll + 1 >= maxPolls) {
      return { verified: false, newMemberOwnerId: null, waitedMs: at - startedAt, rosterOwnerIds };
    }
    await sleep(intervalMs);
  }
}

/** fleet:kill returns the bulk envelope `{ data: { ok, results, counts } }` — success is
 * zero failed items (top-level `ok` only means the batch ran). A structured not_found for the
 * already-resolved fleet member is the idempotent already-dead precondition, not a hard failure. */
function killOutcome(res: unknown): { ok: boolean; alreadyGone: boolean; data: Record<string, unknown> } {
  const data = ((res as { data?: unknown }).data ?? {}) as Record<string, unknown>;
  const counts = data.counts as { failed?: number } | undefined;
  const results = data.results as { ok?: boolean; code?: string; error?: string }[] | undefined;
  const failed = counts?.failed ?? results?.filter((r) => r.ok === false).length ?? 0;
  // `resolveFleetMemberTarget` already proved this owner belongs to the fleet. If fleet:kill
  // then reports its host as absent, the requested drain is already satisfied: there is no old
  // process left that could race the replacement. Treat only the structured not_found result as
  // this idempotent already-dead case; every other kill failure must still abort the relaunch.
  const alreadyGone = failed > 0 && Boolean(results?.length) && results!.every(
    (r) => r.ok === false && (r.code === 'not_found' || r.error === 'not_found'),
  );
  return { ok: failed === 0, alreadyGone, data };
}

/** capability:launch-agent returns human-readable TEXT + an `isError` flag (not JSON) —
 *  success is `!isError`. */
function launchOutcome(res: unknown): { ok: boolean; text: string } {
  const env = res as { isError?: boolean; content?: { text?: string }[] };
  return { ok: !env.isError, text: env.content?.[0]?.text ?? '' };
}

export default defineTool({
  name: 'fleet:respawn-member',
  description:
    "Change ONE fleet member's BOOT-BAKED settings (model / effort / account / contextSize / agent / compactionLimit) by draining + relaunching it (as its leader/queen/owner): the old session is killed (releasing its claims) and a fresh one is launched into the SAME fleet with the new spec (a new identity, the fleet's claim lane inherited). `fleet` defaults to the one you lead. For RUNTIME settings that need no respawn (compaction limit alone, claim spec, a brief) use fleet:reconfigure-member. `carry`/`claimKinds` are not settable here.",
  guidance: {
    when: 'Move a member to a different model/effort/account/context-size/agent CLI — anything fixed at launch. It kills the old session and relaunches a replacement in the same fleet.',
    notWhen:
      'For a RUNTIME tweak with no respawn (compaction limit, claim lane, a next-wake brief) — fleet:reconfigure-member. To change carry or seed claimKinds — fleet:launch-on-plan. To stand the whole fleet down — fleet:wind-down. To just kill (no replacement) — fleet:kill.',
    chaining: ROUTING_LADDER,
    seeAlso: [
      'fleet:reconfigure-member (runtime settings, no respawn)',
      'capability:launch-agent (the underlying fresh launch)',
      'fleet:kill (kill without replacement)',
      'fleet:status (who the members are)',
    ],
  },
  capability: 'fleet:respawn-member',
  requirePrincipal: false,
  // EI-20215222062407258: this orchestration awaits the drain, launch, and (by default)
  // up-to-90-second replacement-heartbeat verification without reading ctx.tx. Holding the
  // dispatcher's ambient workspace transaction across that wait lets Postgres terminate its
  // idle backend during a concurrent respawn wave, surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      member: z
        .string()
        .min(1)
        .describe('The member to respawn — its coord ownerId (or a unique prefix/substring). Must be a member of the fleet.'),
      fleet: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Fleet slug (or name — slugified). Defaults to the single fleet you lead.'),
      model: z.string().max(80).optional().describe('New model spec (e.g. "opus[1m]", "sonnet:high").'),
      effort: z.string().max(40).optional().describe('New reasoning effort (low|medium|high|xhigh|max) — composed onto the model spec.'),
      account: z.string().max(120).optional().describe('New account routing (default | auto | a pool account id).'),
      contextSize: z.enum(['full', 'trimmed']).optional().describe('New psu --context-size for the relaunched member.'),
      agent: z.string().max(40).optional().describe('New agent CLI backing the member (e.g. claude | codex).'),
      compactionLimit: z.number().int().min(20_000).max(900_000).optional().describe('New soft compaction limit (tokens) baked at launch.'),
      headless: z.boolean().optional().describe('Whether the replacement runs headless (default: preserve the fleet norm — headless for a background drain fleet).'),
      brief: z
        .string()
        .min(1)
        .max(4000)
        .optional()
        .describe("The replacement's FIRST TURN. Omit to use a generic 'you were respawned, resume your role (self-pull via scheduler:get_next)' brief."),
      reason: z.string().max(500).optional().describe('Why — recorded on the kill audit row.'),
      idempotencyKey: z
        .string()
        .max(200)
        .optional()
        .describe('Dedupe key for the relaunch: re-firing with the same key reports deduped instead of launching a second replacement.'),
      verifySec: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe(`Seconds to wait for the replacement's first heartbeat before reporting the respawn failed (default ${DEFAULT_VERIFY_SEC}). 0 skips verification and returns as soon as the launcher does — the launcher only knows it spawned a terminal, so ok:true then means "launch requested", not "agent exists".`),
    })
    .refine(
      (a) =>
        a.model != null ||
        a.effort != null ||
        a.account != null ||
        a.contextSize != null ||
        a.agent != null ||
        a.compactionLimit != null ||
        a.headless != null,
      { message: 'pass at least one boot-baked setting to change (model/effort/account/contextSize/agent/compactionLimit/headless); for a runtime-only change use fleet:reconfigure-member' },
    ),
  async handler(args, ctx) {
    // Defense-in-depth (zod refine covers the MCP path): a respawn must change ≥1 boot-baked field.
    const changed = { model: args.model, effort: args.effort, account: args.account, contextSize: args.contextSize, agent: args.agent, compactionLimit: args.compactionLimit, headless: args.headless };
    const changedFields = Object.entries(changed).filter(([, v]) => v != null).map(([k]) => k);
    if (changedFields.length === 0) {
      return json({ ok: false, error: 'nothing_to_respawn', message: 'pass at least one boot-baked setting to change; for a runtime-only change use fleet:reconfigure-member' }, true);
    }

    const target = await resolveFleetMemberTarget(ctx, args.member, args.fleet);
    if (!target.ok) {
      return json(target as unknown as Record<string, unknown>, true);
    }
    const { slug, memberOwnerId, invokedAs, workspaceId } = target;

    // D-004/P-044: a respawn is a recovery, never a fresh reconstruction. Read
    // the canonical saved fleet profile BEFORE killing the old member, merge
    // only the explicit audited boot-setting delta, and preserve every omitted
    // field (plan/harness/account/carry/role/context/launch context included).
    const savedLaunchSpec = await resolveSavedFleetLaunchSpec({
      workspaceId,
      fleetSlug: slug,
      requested: {
        model: args.model,
        effort: args.effort,
        account: args.account,
        contextSize: args.contextSize,
        agent: args.agent,
        compactionLimit: args.compactionLimit,
        headless: args.headless,
        brief: args.brief,
      },
      allowDeltas: ['model', 'account', 'contextSize', 'agent', 'compactionLimit', 'headless', 'brief'],
      reusePath: 'fleet:respawn-member -> capability:launch-agent',
      requireSaved: true,
    });
    if (!savedLaunchSpec.ok) {
      return json(
        {
          ok: false,
          error: savedLaunchSpec.error,
          fleet: slug,
          member: memberOwnerId,
          message: savedLaunchSpec.message,
          conflicts: savedLaunchSpec.conflicts,
          provenance: savedLaunchSpec.provenance,
          reusePath: savedLaunchSpec.reusePath,
          killed: false,
        },
        true,
      );
    }
    if (!savedLaunchSpec.found) {
      // `requireSaved:true` makes this unreachable at runtime; retain an
      // explicit defense so a future resolver contract change cannot kill first.
      return json(
        {
          ok: false,
          error: 'saved_launch_spec_missing',
          fleet: slug,
          member: memberOwnerId,
          message: `No canonical saved launch spec exists for fleet '${slug}'; old member was NOT killed.`,
          killed: false,
        },
        true,
      );
    }

    // 0. Snapshot the fleet's roster BEFORE the kill, so the replacement is identified by being
    //    an owner-id that was not there before — a respawn mints a NEW identity, so "some member
    //    is present" is not evidence; "a member nobody had seen is present" is.
    let rosterBefore = new Set<string>();
    let rosterReadable = true;
    try {
      rosterBefore = new Set((await listFleetPresence(workspaceId, slug)).map((r) => r.ownerId));
    } catch {
      rosterReadable = false;
    }

    // 1. Drain the old session (graceful SIGTERM + close its terminal; releases its claims). If the
    //    kill fails we do NOT launch a replacement — otherwise two members race the same lane.
    const kill = killOutcome(
      await killTool.handler(
        { owner: memberOwnerId, reason: args.reason ?? `fleet:respawn-member (${changedFields.join(',')})`, close_terminal: true } as never,
        ctx,
      ),
    );
    if (!kill.ok && !kill.alreadyGone) {
      return json({ ok: false, error: 'kill_failed', fleet: slug, member: memberOwnerId, killed: kill.data, message: 'could not drain the old member — NOT launching a replacement (would double-run the lane).' }, true);
    }

    // 2. Fresh-launch the replacement into the SAME fleet from the RESOLVED
    //    canonical spec. The caller's explicit delta is already audited above;
    //    nothing omitted can now fall through to a system default.
    const brief =
      savedLaunchSpec.effective.member.brief ??
      `You were respawned into fleet '${slug}' with new settings (${changedFields.join(', ')}). Resume your role: if you are a self-pulling fleet member, pull work via scheduler:get_next, then verify + complete with evidence.`;
    const spec: MemberSpec = {
      ...savedLaunchSpec.effective.member,
      brief,
    };
    const launch = launchOutcome(
      await launchTool.handler(
        {
          fleet: slug,
          count: 1,
          plan: savedLaunchSpec.effective.plan,
          harness: savedLaunchSpec.effective.harness,
          members: [spec],
          __savedLaunchCarry: savedLaunchSpec.effective.member.carry,
          ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
        } as never,
        ctx,
      ),
    );

    if (!launch.ok) {
      return json(
        {
          ok: false,
          fleet: slug,
          oldMember: memberOwnerId,
          invokedAs,
          changed: changedFields,
          drainOutcome: kill.alreadyGone ? 'already-dead' : 'killed',
          killed: kill.data,
          launched: launch.text,
          launchSpec: {
            provenance: savedLaunchSpec.provenance,
            reusePath: savedLaunchSpec.reusePath,
            overrides: savedLaunchSpec.overrides,
            preservedFields: savedLaunchSpec.preservedFields,
          },
          verified: false,
          message: 'old member drained but the replacement launch FAILED — the fleet is down one member; relaunch it (capability:launch-agent) or retry.',
        },
        true,
      );
    }

    // 3. VERIFY the replacement actually booted. The launcher can only report that it spawned a
    //    terminal, and that terminal outlives a CLI that dies on its first call — so without this
    //    step ok:true means "a window opened", which reads as "the member is back" and is how a
    //    respawn silently leaves a fleet a member down (WI-6936).
    const verifySec = args.verifySec ?? DEFAULT_VERIFY_SEC;
    if (verifySec === 0 || !rosterReadable) {
      return json({
        ok: true,
        fleet: slug,
        oldMember: memberOwnerId,
        invokedAs,
        changed: changedFields,
        drainOutcome: kill.alreadyGone ? 'already-dead' : 'killed',
        killed: kill.data,
        launched: launch.text,
        launchSpec: {
          provenance: savedLaunchSpec.provenance,
          reusePath: savedLaunchSpec.reusePath,
          overrides: savedLaunchSpec.overrides,
          preservedFields: savedLaunchSpec.preservedFields,
        },
        verified: false,
        verification: rosterReadable ? 'skipped' : 'unavailable',
        message: `Launch REQUESTED but NOT verified${rosterReadable ? ' (verifySec:0)' : ' (the fleet presence roster could not be read)'} — the launcher only knows it spawned a terminal, which survives a CLI that dies before its first turn. Confirm a real agent exists before relying on it: fleet:leader-brief { fleet:'${slug}', include_stale:true } and require a NEW member with loopMode set and a fresh heartbeat.`,
      });
    }

    const verify = await awaitReplacementMember({
      before: rosterBefore,
      list: () => listFleetPresence(workspaceId, slug),
      timeoutMs: verifySec * 1000,
    });

    return json(
      {
        ok: verify.verified,
        fleet: slug,
        oldMember: memberOwnerId,
        invokedAs,
        changed: changedFields,
        drainOutcome: kill.alreadyGone ? 'already-dead' : 'killed',
        killed: kill.data,
        launched: launch.text,
        launchSpec: {
          provenance: savedLaunchSpec.provenance,
          reusePath: savedLaunchSpec.reusePath,
          overrides: savedLaunchSpec.overrides,
          preservedFields: savedLaunchSpec.preservedFields,
        },
        verified: verify.verified,
        newMember: verify.newMemberOwnerId,
        waitedMs: verify.waitedMs,
        ...(verify.verified
          ? {}
          : {
              rosterOwnerIds: verify.rosterOwnerIds,
              message: `The replacement was LAUNCHED but never appeared in the fleet roster within ${verifySec}s — the terminal spawned and the agent CLI did not come up (an exhausted account pool, a bad model/agent spec, or a missing credential all present this way). The fleet is DOWN A MEMBER. Check fleet:capacity before relaunching; a spawn into an exhausted pool dies the same way again.`,
            }),
      },
      !verify.verified,
    );
  },
});
