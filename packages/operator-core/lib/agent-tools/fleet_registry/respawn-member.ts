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
import { json, ROUTING_LADDER } from './_shared';

/** fleet:kill returns the bulk envelope `{ data: { ok, results, counts } }` — success is
 *  zero failed items (top-level `ok` only means the batch ran). */
function killOutcome(res: unknown): { ok: boolean; data: Record<string, unknown> } {
  const data = ((res as { data?: unknown }).data ?? {}) as Record<string, unknown>;
  const counts = data.counts as { failed?: number } | undefined;
  const results = data.results as { ok?: boolean }[] | undefined;
  const failed = counts?.failed ?? results?.filter((r) => r.ok === false).length ?? 0;
  return { ok: failed === 0, data };
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
    const { slug, memberOwnerId, invokedAs } = target;

    // 1. Drain the old session (graceful SIGTERM + close its terminal; releases its claims). If the
    //    kill fails we do NOT launch a replacement — otherwise two members race the same lane.
    const kill = killOutcome(
      await killTool.handler(
        { owner: memberOwnerId, reason: args.reason ?? `fleet:respawn-member (${changedFields.join(',')})`, close_terminal: true } as never,
        ctx,
      ),
    );
    if (!kill.ok) {
      return json({ ok: false, error: 'kill_failed', fleet: slug, member: memberOwnerId, killed: kill.data, message: 'could not drain the old member — NOT launching a replacement (would double-run the lane).' }, true);
    }

    // 2. Fresh-launch the replacement into the SAME fleet with the new declarative MemberSpec. Only
    //    the provided fields are set; unset ones fall through to the fleet/system defaults.
    const brief = args.brief ?? `You were respawned into fleet '${slug}' with new settings (${changedFields.join(', ')}). Resume your role: if you are a self-pulling fleet member, pull work via scheduler:get_next, then verify + complete with evidence.`;
    const spec: MemberSpec = {
      ...(args.model != null ? { model: args.model } : {}),
      ...(args.effort != null ? { effort: args.effort } : {}),
      ...(args.account != null ? { account: args.account } : {}),
      ...(args.contextSize != null ? { contextSize: args.contextSize } : {}),
      ...(args.agent != null ? { agent: args.agent } : {}),
      ...(args.compactionLimit != null ? { compactionLimit: args.compactionLimit } : {}),
      ...(args.headless != null ? { headless: args.headless } : {}),
      brief,
    };
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harness = typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : undefined;
    const launch = launchOutcome(
      await launchTool.handler(
        {
          fleet: slug,
          count: 1,
          members: [spec],
          ...(harness ? { harness } : {}),
          ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
        } as never,
        ctx,
      ),
    );

    return json(
      {
        ok: launch.ok,
        fleet: slug,
        oldMember: memberOwnerId,
        invokedAs,
        changed: changedFields,
        killed: kill.data,
        launched: launch.text,
        ...(launch.ok
          ? {}
          : { message: 'old member drained but the replacement launch FAILED — the fleet is down one member; relaunch it (capability:launch-agent) or retry.' }),
      },
      !launch.ok,
    );
  },
});
