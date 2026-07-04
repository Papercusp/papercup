/**
 * events sugar verbs — thin, DISCOVERABLE named waits over `events:await`
 * (event-await-discoverability-and-coverage-2026-07-03 P-003, D-002/D-005).
 *
 * Each verb is a ~convenience wrapper that (a) puts a named await in the tool list
 * so an agent FINDS it (the whole plan's point — agents poll because they never
 * find `events:await`), and (b) builds the correctly-shaped key from the catalog
 * (`events/await/catalog.ts` — the single source of truth) so a key shape lives in
 * exactly one place. NOT a second subscription system: every verb resolves to the
 * same `registerAwait` the raw `events:await` uses. Mirrors how `coord:wake` /
 * `coord:dispatch` hide the `coord:inbox-wake:<owner>` key.
 *
 * D-005: because the sugar sources keys from the catalog, a future Phase 4 (fold
 * await into the ECA engine) reshapes HOW these resolve, not the verbs themselves.
 *
 * DUAL-OUTCOME verbs (deploy, checkpoint) arm awaits on the two MUTUALLY-EXCLUSIVE
 * outcome keys (success + failure) so the agent wakes either way — safe because a
 * deploy either lands OR fails, never both, so there is no double-wake. Keys that
 * CO-fire (the general work-item:status and the specific work-item:done) are never
 * armed together — the verb picks exactly one.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait } from '../../events/await/store';
import { startAwaitSweeper } from '../../events/await/engine';
import { buildKey } from '../../events/await/catalog';
import { clampText, LIMITS } from '../limits';

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): 30min default, matches events:await.
// Aliased to the local names so every usage/describe below is unchanged.
import { AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC } from '../../events/await/types';

/** Shared timeout arg — identical semantics to events:await's. */
const timeoutArg = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_SEC)
  .optional()
  .describe(`Deadline in seconds (default ${DEFAULT_TIMEOUT_SEC}); on the deadline you are woken with a TIMEOUT marker.`);

/**
 * Arm one or more awaits sharing ONE wake handle (captured now — the agent is
 * asleep at fire time). Mirrors events:await, so the sugar and the raw verb are
 * the same primitive. Returns the registered keys + a resume advice line.
 */
async function armAwaits(
  ctx: Parameters<typeof resolveAgentIdentity>[0],
  keys: string[],
  note: string,
  timeoutSec: number | undefined,
): Promise<{ ok: true; events: string[]; await_ids: number[]; advice: string }> {
  const identity = resolveAgentIdentity(ctx);
  startAwaitSweeper();
  const { handle } = await captureWakeHandleForOwner(identity.ownerId, {});
  const awaitIds: number[] = [];
  for (const key of keys) {
    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: key,
      policy: 'wake',
      note: clampText(note, LIMITS.ANNOTATION) ?? null,
      wakeHandle: handle,
      timeoutBehavior: 'wake',
      timeoutSec: timeoutSec ?? DEFAULT_TIMEOUT_SEC,
      workspaceId: identity.workspaceId ?? undefined,
    });
    awaitIds.push(row.id);
  }
  return {
    ok: true,
    events: keys,
    await_ids: awaitIds,
    advice: 'Registered. End your turn now — you are re-invoked when it fires (or at the deadline). Do not poll.',
  };
}

function reply(body: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
}

// ── deploy:await — "wake when my sha is live on :3070" ───────────────────────
defineTool({
  name: 'deploy:await',
  description:
    'Sleep until a deploy lands (a staging sha reaches the live GREEN :3070 operator) instead of polling dev:pipeline_position. Arms awaits on BOTH release:deployed (success) and release:deploy-failed (failure) so you wake either way. Pass sha to target a specific commit; omit to wake on the next deploy of any sha. Then END YOUR TURN.',
  capability: 'coord:write',
  guidance: {
    when: 'You left an edit in the tree and need it LIVE on :3070 before your next step — instead of re-polling dev:pipeline_position, arm this and end your turn.',
    notWhen: 'Just checking where a change sits (not blocked on it) — that is dev:pipeline_position, one read. Forcing a deploy — release:deploy / the deploy-cli.',
    chaining: 'deploy:await { sha } → end turn → on wake, payload.sha confirms which deploy landed; resume the work that needed it live.',
    seeAlso: ['events:catalog (all awaitable keys)', 'dev:pipeline_position (a one-shot position read)', 'events:await (the raw primitive)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sha: z.string().min(4).max(64).optional().describe('Target commit sha; omit to wake on the next deploy of any sha (the global key).'),
    note: z.string().max(LIMITS.ANNOTATION).optional().describe('Why you are waiting — echoed into the wake turn.'),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    const keys = [buildKey('deploy', { sha: args.sha }), buildKey('deploy-failed')];
    const note = args.note ?? `deploy:await${args.sha ? ` ${args.sha}` : ''} — blocked until the deploy lands (or fails)`;
    return reply(await armAwaits(ctx, keys, note, args.timeout_sec));
  },
});

// ── checkpoint:await — "wake when the green gate resolves" ────────────────────
defineTool({
  name: 'checkpoint:await',
  description:
    'Sleep until the green-checkpoint resolves — arms awaits on BOTH release:green (passed → advanced to main) and green-checkpoint:red (held → not green) so you wake either way, instead of polling for the gate verdict. The gate keys are global (one per checkpoint run), so check payload.sha on wake. Then END YOUR TURN.',
  capability: 'coord:write',
  guidance: {
    when: 'You need to know whether the gate went green (your change cleared into main) or is held (a test is red) before proceeding — instead of re-polling dev:pipeline_position / dev:build_status.',
    notWhen: 'Waiting for the DEPLOY (past the gate, live on :3070) — that is deploy:await. Configuring the gate — release:checkpoint-config.',
    chaining: 'checkpoint:await → end turn → on wake, payload tells you green (advanced) or red (payload.summary = failing tail); resume or go fix the red.',
    seeAlso: ['events:catalog', 'deploy:await (the next stage — live on :3070)', 'events:await'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    note: z.string().max(LIMITS.ANNOTATION).optional().describe('Why you are waiting — echoed into the wake turn.'),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    const keys = [buildKey('checkpoint'), buildKey('checkpoint-red')];
    return reply(await armAwaits(ctx, keys, args.note ?? 'checkpoint:await — blocked until the green gate resolves', args.timeout_sec));
  },
});

// ── work-item:await — "wake on a work item's status change" ───────────────────
const WI_STATE_FAMILY: Record<string, string> = {
  done: 'work-item-done',
  unblocked: 'work-item-unblocked',
  blocked: 'work-item-blocked',
  claimed: 'work-item-claimed',
};

defineTool({
  name: 'work-item:await',
  description:
    'Sleep until a work item changes status instead of polling work_items:get. With no `state`, arms the general work-item:status:<id> (ANY transition). With a single `state` (done|unblocked|blocked|claimed), arms only that specific key. Then END YOUR TURN.',
  capability: 'coord:write',
  guidance: {
    when: 'You are blocked on a peer/dependency work item (its completion, unblock, or any transition) — arm this and end your turn instead of re-reading work_items:get.',
    notWhen: 'Just inspecting an item once — work_items:get. Waiting on a PLAN item (P-NNN) — plan-item:await. Ambient interest in a topic — topics:subscribe.',
    chaining: 'work-item:await { id: "WI-123", state: "done" } → end turn → on wake the item has settled; continue.',
    seeAlso: ['events:catalog', 'work_items:get (one-shot read)', 'plan-item:await', 'events:await'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    id: z.string().min(1).max(64).describe('The work-item id, e.g. WI-1234.'),
    state: z
      .enum(['any', 'done', 'unblocked', 'blocked', 'claimed'])
      .optional()
      .describe("Which transition to wake on. 'any' (default) = the general status key; a specific state arms only that key."),
    note: z.string().max(LIMITS.ANNOTATION).optional().describe('Why you are waiting — echoed into the wake turn.'),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    const state = args.state ?? 'any';
    const key =
      state === 'any' ? buildKey('work-item', { id: args.id }) : buildKey(WI_STATE_FAMILY[state], { id: args.id });
    return reply(await armAwaits(ctx, [key], args.note ?? `work-item:await ${args.id} (${state})`, args.timeout_sec));
  },
});

// ── service:await-up — "wake when a service recovers" ────────────────────────
defineTool({
  name: 'service:await-up',
  description:
    'Sleep until a monitored service transitions back to HEALTHY (service:up:<name>) instead of re-polling dev:service_health. Then END YOUR TURN.',
  capability: 'coord:write',
  guidance: {
    when: 'A service you depend on is down and you need it back before proceeding — arm this and end your turn instead of re-polling dev:service_health.',
    notWhen: 'A one-shot health check — dev:service_health. Restarting the service yourself — the systemctl/dev:restart path.',
    chaining: 'service:await-up { name: "inference-gateway" } → end turn → on wake it is healthy; resume.',
    seeAlso: ['events:catalog', 'dev:service_health (one-shot read)', 'events:await'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    name: z.string().min(1).max(120).describe('The service name, e.g. inference-gateway / substrate-sidecar / git-sync.'),
    note: z.string().max(LIMITS.ANNOTATION).optional().describe('Why you are waiting — echoed into the wake turn.'),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(await armAwaits(ctx, [buildKey('service-up', { name: args.name })], args.note ?? `service:await-up ${args.name}`, args.timeout_sec));
  },
});

// ── git-sync:await — "wake when my edit is committed" ────────────────────────
defineTool({
  name: 'git-sync:await',
  description:
    'Sleep until git-sync commits the tree (git-sync:committed:<sha>) — the "is my edit committed yet" wait — instead of polling dev:pipeline_position. Pass sha to target a commit; omit to wake on the next git-sync commit. Then END YOUR TURN.',
  capability: 'coord:write',
  guidance: {
    when: 'You left an edit in the tree and your next step needs it COMMITTED (on origin/staging) — arm this and end your turn instead of re-polling dev:pipeline_position.',
    notWhen: 'You need it LIVE on :3070 (past commit → gate → deploy) — that is deploy:await. You own the commit yourself — you do not (git-sync owns commit+push).',
    chaining: 'edit a file → git-sync:await → end turn → on wake it is committed; continue.',
    seeAlso: ['events:catalog', 'dev:pipeline_position', 'deploy:await (the later "live on :3070" stage)', 'events:await'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sha: z.string().min(4).max(64).optional().describe('Target commit sha; omit to wake on the next git-sync commit.'),
    note: z.string().max(LIMITS.ANNOTATION).optional().describe('Why you are waiting — echoed into the wake turn.'),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(await armAwaits(ctx, [buildKey('git-sync', { sha: args.sha })], args.note ?? 'git-sync:await — blocked until committed', args.timeout_sec));
  },
});

// ── plan-item:await — "wake when a plan item is done" ────────────────────────
defineTool({
  name: 'plan-item:await',
  description:
    'Sleep until a plan item flips to done (plan-item:done:<slug>:<id>) instead of polling plans:get. Then END YOUR TURN.',
  capability: 'coord:write',
  guidance: {
    when: 'You are blocked on another plan item (a dependency P-NNN) finishing before you can proceed — arm this and end your turn instead of re-reading plans:get.',
    notWhen: 'Inspecting a plan once — plans:get. Waiting on a WORK item (WI-NNN) — work-item:await.',
    chaining: 'plan-item:await { slug, id: "P-014" } → end turn → on wake the item is done; continue.',
    seeAlso: ['events:catalog', 'plans:get (one-shot read)', 'work-item:await', 'events:await'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1).max(200).describe('The plan slug.'),
    id: z.string().min(1).max(16).describe('The plan item id, e.g. P-014.'),
    note: z.string().max(LIMITS.ANNOTATION).optional().describe('Why you are waiting — echoed into the wake turn.'),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(await armAwaits(ctx, [buildKey('plan-item', { slug: args.slug, id: args.id })], args.note ?? `plan-item:await ${args.slug}:${args.id}`, args.timeout_sec));
  },
});

// ── fleet:await-drained — "wake when my fleet's lanes are all done" ──────────
defineTool({
  name: 'fleet:await-drained',
  description:
    'Sleep until every claimable item in a fleet\'s lanes is done (fleet:drained:<slug>) — the leader\'s "wake me when the fleet drains so I can loop:end + write the scorecard" wait — instead of re-checking the roster. Then END YOUR TURN.',
  capability: 'coord:write',
  guidance: {
    when: 'You lead a fleet and are waiting for it to finish all lanes before you loop:end + write the fleet-execution-health scorecard — arm this and end your turn instead of re-polling the roster each wake.',
    notWhen: 'You still have leadership work to do this wake (directing members, acking pings). Checking roster once — fleet:status / coord:roster.',
    chaining: 'fleet:await-drained { slug } → end turn → on wake the lanes are drained; loop:end + scorecard.',
    seeAlso: ['events:catalog', 'fleet:status (one-shot roster)', 'loop:end', 'events:await'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe('The fleet slug.'),
    note: z.string().max(LIMITS.ANNOTATION).optional().describe('Why you are waiting — echoed into the wake turn.'),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(await armAwaits(ctx, [buildKey('fleet-drained', { slug: args.slug })], args.note ?? `fleet:await-drained ${args.slug}`, args.timeout_sec));
  },
});
