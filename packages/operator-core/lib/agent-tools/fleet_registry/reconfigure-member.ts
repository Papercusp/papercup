/**
 * fleet:reconfigure-member — a fleet LEADER reconfigures ONE live member's RUNTIME-adjustable
 * settings WITHOUT a respawn (per-member-declarative-launch-specs P-007, D-003). The three
 * no-respawn levers, bundled behind a single member-targeted call so the leader does not have
 * to fan out three separate tools:
 *   • compactionLimit → the P-006 cross-session setter (setCompactionLimitForOwner), clamped to
 *     the MEMBER's spec + fleet-role ceiling.
 *   • claimSpec       → the member's versioned claim spec (scheduler:set_claim_spec's cupId path)
 *     — validated, then stored under the member's own cupId so its next scheduler:get_next applies
 *     it. For the write-time pool-collapse guard use scheduler:set_claim_spec directly.
 *   • brief           → a next-wake brief: a durable coord message the member reads on its next
 *     wake/orient (no forced wake).
 *
 * Boot-baked settings (model/effort/account/carry/contextSize/agent) need a respawn — that is
 * fleet:respawn-member (P-008), not this. Auth reuses the fleet-control classifier
 * (classifyFleetControlInvoker): the caller must be the target fleet's recorded leader, the queen,
 * or the owner (su).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, classifyAgentPane } from '@papercusp/agent-mcp';
import { getFleet, listFleetsLedBy, fleetSlugFromName } from '../../agent-fleets-store';
import { getPresence } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { sendMessage } from '../coordination/messages';
import { validateClaimSpec } from '../../scheduler/claim-spec';
import { resolveClaimSpecWorkspace, setClaimSpec } from '../../scheduler/claim-spec-store';
import { setCompactionLimitForOwner } from '../config/set-compaction-limit-core';
import { classifyFleetControlInvoker } from './fleet-auth';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

/** Resolve a `member` handle (a full coord ownerId, or a unique prefix/substring) to the
 *  ownerId + fleet-role of an actual member of `slug`. Membership is checked against the
 *  authoritative presence-fleet label (includes muted members); prefix resolution enumerates
 *  the deliverable member set. */
async function resolveMemberInFleet(
  member: string,
  slug: string,
): Promise<{ ok: true; ownerId: string; role: string } | { ok: false; error: string; message: string }> {
  const trimmed = member.trim();
  // Exact: the handle is itself a member of this fleet (authoritative label, muted-inclusive).
  const directRole = (await fetchPresenceFleet([trimmed]).catch(() => new Map())).get(trimmed);
  if (directRole?.fleetSlug === slug) {
    return { ok: true, ownerId: trimmed, role: directRole.fleetRole ?? 'member' };
  }
  // Prefix/substring: enumerate the fleet's members and match uniquely.
  const { hostAudienceResolvers } = await import('../coordination/audience-host');
  const members = (await hostAudienceResolvers.listFleetMembers(slug).catch(() => [])) as string[];
  const matches = members.filter((id) => id === trimmed || id.startsWith(trimmed) || id.includes(trimmed));
  if (matches.length === 1) {
    const role = (await fetchPresenceFleet([matches[0]]).catch(() => new Map())).get(matches[0]);
    return { ok: true, ownerId: matches[0], role: role?.fleetRole ?? 'member' };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: 'member_not_found',
      message: `No member matching "${member}" in fleet '${slug}' — fleet:status lists its members.`,
    };
  }
  return {
    ok: false,
    error: 'member_ambiguous',
    message: `"${member}" matches ${matches.length} members of '${slug}' (${matches.join(', ')}) — pass a full ownerId.`,
  };
}

export default defineTool({
  name: 'fleet:reconfigure-member',
  description:
    "Reconfigure ONE live fleet member's RUNTIME settings WITHOUT a respawn (as its leader/queen/owner): `compactionLimit` (clamped to the member's own spec+role ceiling), `claimSpec` (its versioned claim spec — validated, applied on its next scheduler:get_next), and/or `brief` (a next-wake message it reads on its next orient). `fleet` defaults to the one fleet you lead. For BOOT-BAKED settings (model/effort/account/carry/contextSize/agent) use fleet:respawn-member instead.",
  guidance: {
    when: 'Adjust a member you lead in place — retune its compaction window, re-steer its claim lane, or stage a next-wake brief — without the cost of a respawn. Pass just the fields you want to change.',
    notWhen:
      'To change boot-baked settings (model/effort/account/carry/contextSize/agent) — those need fleet:respawn-member. To steer with the write-time pool-collapse guard — scheduler:set_claim_spec directly. To stand the whole fleet down — fleet:wind-down.',
    chaining: ROUTING_LADDER,
    seeAlso: [
      'fleet:respawn-member (boot-baked settings, via a respawn)',
      'config:set-compaction-limit (set your OWN limit)',
      'scheduler:set_claim_spec (guarded claim-spec steering)',
      'fleet:status (who the members are)',
    ],
  },
  capability: 'fleet:reconfigure-member',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      member: z
        .string()
        .min(1)
        .describe("The target member — its coord ownerId (or a unique prefix/substring). Must be a member of the fleet."),
      fleet: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Fleet slug (or name — slugified). Defaults to the single fleet you lead; required if you lead several / act as queen/owner over another fleet.'),
      compactionLimit: z
        .number()
        .int()
        .min(20_000)
        .max(900_000)
        .optional()
        .describe("New soft compaction limit (tokens) for the member — clamped to ITS model+fleet-role ceiling (a member's leaner [1m] cap), not yours."),
      claimSpec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A claim spec (same shape scheduler:set_claim_spec takes: { specVersion:"1.0", specId, revision, view:{filter}, rank, states? }) — validated, then stored under the member\'s cupId; applied on its next scheduler:get_next. No write-time pool-collapse guard here — use scheduler:set_claim_spec for that.'),
      brief: z
        .string()
        .min(1)
        .max(4000)
        .optional()
        .describe('A next-wake brief — a durable coord message the member reads on its next wake/orient (does NOT force an immediate wake).'),
    })
    .refine((a) => a.compactionLimit != null || a.claimSpec != null || a.brief != null, {
      message: 'pass at least one of compactionLimit / claimSpec / brief',
    }),
  async handler(args, ctx) {
    const { identity, ownerId: callerId, workspaceId } = resolveFleetCaller(ctx);

    // Defense-in-depth (the zod refine covers the MCP path): at least one lever.
    if (args.compactionLimit == null && args.claimSpec == null && args.brief == null) {
      return json({ ok: false, error: 'nothing_to_do', message: 'pass at least one of compactionLimit / claimSpec / brief' }, true);
    }

    // 1. Resolve the fleet — explicit, else the single fleet the caller leads.
    let slug: string;
    let fleet;
    if (args.fleet) {
      slug = fleetSlugFromName(args.fleet);
      fleet = await getFleet(workspaceId, slug);
      if (!fleet) {
        return json({ ok: false, error: 'fleet_not_found', message: `No fleet '${slug}' in this workspace — see fleet:list.` }, true);
      }
    } else {
      const led = await listFleetsLedBy(workspaceId, callerId);
      if (led.length === 0) {
        return json({ ok: false, error: 'no_led_fleet', message: 'You lead no fleet — pass `fleet` explicitly (and you must be its leader/queen/owner).' }, true);
      }
      if (led.length > 1) {
        return json({ ok: false, error: 'ambiguous_fleet', message: `You lead ${led.length} fleets (${led.map((f) => f.fleetSlug).join(', ')}) — pass \`fleet\`.` }, true);
      }
      fleet = led[0];
      slug = fleet.fleetSlug;
    }

    // 2. Auth — leader of THIS fleet, queen, or owner (su). Pane derives from live presence.
    let paneKind = 'unknown';
    try {
      const pres = await getPresence(callerId).catch(() => null);
      paneKind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId: callerId }).kind;
    } catch {
      paneKind = classifyAgentPane({ role: null, ownerId: callerId }).kind;
    }
    const invokedAs = classifyFleetControlInvoker({ callerOwnerId: callerId, leaderOwnerId: fleet.leaderOwnerId, paneKind });
    if (!invokedAs) {
      return json(
        {
          ok: false,
          error: 'not_authorized',
          message:
            `fleet:reconfigure-member on '${slug}' is restricted to its recorded leader (${fleet.leaderOwnerId ?? 'none'}), ` +
            `the queen, or the owner (an su session) — you are ${paneKind} (${callerId}).`,
        },
        true,
      );
    }

    // 3. Resolve the target member within the fleet.
    const resolved = await resolveMemberInFleet(args.member, slug);
    if (!resolved.ok) {
      return json({ ...resolved, fleet: slug }, true);
    }
    const memberOwnerId = resolved.ownerId;

    // 4. Apply each requested lever, collecting a per-lever result.
    const applied: Record<string, unknown> = {};

    if (args.compactionLimit != null) {
      // Reuse the P-006 cross-session setter (re-runs the same auth harmlessly, and clamps to
      // the MEMBER's spec+role ceiling — the value-add over a naive write).
      applied.compactionLimit = await setCompactionLimitForOwner(ctx, memberOwnerId, args.compactionLimit);
    }

    if (args.claimSpec != null) {
      const validated = validateClaimSpec(args.claimSpec);
      if (!validated.ok || !validated.spec) {
        applied.claimSpec = { ok: false, errors: validated.errors };
      } else {
        try {
          // Federate under the caller's harness when harness-scoped (mirrors set_claim_spec's
          // potSlug resolution for the common case); else local.
          const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
          const potSlug =
            typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : null;
          const res = await setClaimSpec({
            cupId: memberOwnerId,
            workspaceId: resolveClaimSpecWorkspace(workspaceId),
            spec: args.claimSpec,
            updatedBy: callerId,
            potSlug,
          });
          applied.claimSpec = { ok: true, ...(res as Record<string, unknown>) };
        } catch (e) {
          applied.claimSpec = { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
        }
      }
    }

    if (args.brief != null) {
      try {
        const env = await sendMessage(identity, {
          to: [memberOwnerId],
          summary: `Fleet ${slug} reconfigure brief (from leader ${callerId})`,
          body: args.brief,
          expectsReply: false,
        });
        applied.brief = { ok: true, msgId: (env as { msg_id?: string })?.msg_id ?? null };
      } catch (e) {
        applied.brief = { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
      }
    }

    const anyFail = Object.values(applied).some((r) => r != null && (r as { ok?: boolean }).ok === false);
    return json({ ok: !anyFail, fleet: slug, member: memberOwnerId, invokedAs, applied }, anyFail);
  },
});
