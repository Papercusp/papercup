/**
 * fleet:request_remote_spawn — ask a CONTRIBUTING HOST to spawn fleet members
 * from the seats it delegated to your fleet (agent-allocation-framework
 * P-009, cross-machine launch over P2P).
 *
 * The other machine advertised its delegation as a federated SEAT-OFFER
 * (D-005: "that machine: N model·effort seats, fleet X" — resource:delegate on
 * the contributing host published it). This tool authors the matching SIGNED
 * spawn-request into the same offer store; when it federates, the target
 * host's honor path (delegated-spawn-honor.ts) verifies it, checks its
 * owner-authority accept-delegated-seats gate + live seat availability, and —
 * only then — opens the member terminals joined to YOUR fleet's coord layer.
 *
 * What "success" looks like from here is ASYNC by design: the tool returns as
 * soon as the signed request is stored locally. Watch the members arrive via
 * federated presence (fleet:status / coord:presence); a refusal comes back as
 * a federated p2p receipt (p2p:trace threads it by the request's offer id).
 * A host whose gate is OFF does nothing at all — the request just expires
 * (60 min honor window) — so agree with that machine's owner first.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { listWorkOffers } from '../../p2p/offer-store';
import { publishSpawnRequest } from '../../p2p/spawn-request-publish';
import { fleetRoleFor, json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:request_remote_spawn',
  description:
    'Cross-machine launch: ask the machine that delegated seats to your fleet (its federated seat-offer) to spawn N members from those seats, joined to your fleet and working your plan. Async: returns once the SIGNED request is stored (it federates on the next sync tick); the target host honors it only if its owner enabled accept-delegated-seats. Watch arrivals via fleet:status / federated presence; refusals come back as p2p receipts (p2p:trace).',
  guidance: {
    when:
      "Your fleet holds a REMOTE seat-offer (another machine ran resource:delegate kind:'agent_slot' for your fleet) and you want those seats actually running members. Pick the target from the fleet's open seat-offers (auto-picked when there is exactly one).",
    notWhen:
      'Spawning from seats delegated on THIS machine → fleet:launch-on-plan (it consumes local seats directly). Delegating seats in the first place → resource:delegate on the contributing machine.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:request_remote_spawn',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleet: z.string().min(1).describe('Your fleet slug (the seat-offer must name the same fleet).'),
    plan: z.string().min(1).describe('The plan slug the spawned members work (auto-kickoff on boot).'),
    count: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(1)
      .describe('Members to spawn (1..the seat-offer\'s delegated count; ≤12 per request).'),
    publisher: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Target seat-offer publisher (numeric GitHub user id). Optional when the fleet has exactly one open seat-offer.'),
    offer: z
      .string()
      .min(1)
      .optional()
      .describe('Target seat-offer id (seat-<hex16>). Optional when the fleet has exactly one open seat-offer.'),
    launchContext: z
      .string()
      .min(1)
      .max(8000)
      .optional()
      .describe('Optional brief TEXT for the members (the host composes it under the standard member baseline).'),
  }),
  async handler(args, ctx) {
    const { ownerId, workspaceId } = resolveFleetCaller(ctx);

    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        { ok: false, error: `no fleet '${args.fleet}' in this workspace — create it (fleet:create) before requesting remote members` },
        true,
      );
    }
    if (fleetRoleFor(fleet.leaderOwnerId, ownerId) !== 'leader') {
      return json(
        {
          ok: false,
          error: `only the fleet leader may spend delegated seats — '${args.fleet}' is led by ${fleet.leaderOwnerId ?? '(nobody)'}; take leadership first (fleet:take-leadership) or ask the leader`,
        },
        true,
      );
    }

    const scope = await resolveWorkspaceHiveScope(workspaceId);
    if (scope.kind !== 'one') {
      return json(
        { ok: false, error: `seat-offers federate over the ONE shared hive and this workspace has ${scope.kind === 'none' ? 'none' : 'several'} — cross-machine launch needs a single shared hive` },
        true,
      );
    }

    // Target selection: explicit pair, else the fleet's single open seat-offer.
    let targetPublisher = args.publisher ?? null;
    let targetOffer = args.offer ?? null;
    if ((targetPublisher == null) !== (targetOffer == null)) {
      return json({ ok: false, error: 'pass BOTH publisher + offer to pick a target seat-offer, or NEITHER to auto-pick' }, true);
    }
    const seatOffers = await listWorkOffers(workspaceId, scope.homeSlug, {
      fleetSlug: args.fleet,
      kind: 'seat',
      status: 'open',
    });
    if (targetPublisher == null || targetOffer == null) {
      if (seatOffers.length === 0) {
        return json(
          { ok: false, error: `no open seat-offer for fleet '${args.fleet}' — the contributing machine delegates first (resource:delegate kind:'agent_slot')` },
          true,
        );
      }
      if (seatOffers.length > 1) {
        return json(
          {
            ok: false,
            error: `fleet '${args.fleet}' has ${seatOffers.length} open seat-offers — pass publisher + offer to pick one`,
            candidates: seatOffers.map((o) => ({
              publisher: o.publisherGithubUserId,
              offer: o.offerId,
              host: o.record?.seat?.hostLabel ?? null,
              seats: o.record?.seat ? `${o.record.seat.count} × ${o.record.seat.model}:${o.record.seat.effort}` : null,
            })),
          },
          true,
        );
      }
      targetPublisher = seatOffers[0]!.publisherGithubUserId;
      targetOffer = seatOffers[0]!.offerId;
    }

    const res = await publishSpawnRequest({
      workspaceId,
      fleetSlug: args.fleet,
      targetPublisherGithubUserId: targetPublisher,
      targetOfferId: targetOffer,
      count: args.count,
      planSlug: args.plan,
      requesterOwnerId: ownerId,
      launchContext: args.launchContext ?? null,
    });
    if (!res.ok) {
      return json({ ok: false, error: 'skipped' in res ? `not published: ${res.skipped}` : res.error }, true);
    }
    const seat = seatOffers.find((o) => o.offerId === targetOffer)?.record?.seat ?? null;
    return json({
      ok: true,
      requestOfferId: res.stored.offerId,
      target: { publisher: targetPublisher, offer: targetOffer, host: seat?.hostLabel ?? null },
      count: args.count,
      plan: args.plan,
      next:
        'The signed request federates on the next sync tick. The target host spawns ONLY if its owner enabled accept-delegated-seats (/res) — otherwise the request expires after 60 min. Watch members arrive via fleet:status / coord:presence; a refusal federates back as a p2p receipt (p2p:trace with this requestOfferId).',
    });
  },
});
