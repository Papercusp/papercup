/**
 * events:emit — fire an event through the await-event primitive
 * (await-event-primitive-2026-06-05 P-003, D-001).
 *
 * The agent-facing half of the emit surface (sources inside the host call
 * `emitAwaitedEvent` directly). The emitter is the SOURCE layer: it has
 * already resolved who the event concerns — a targeted key both sides agreed
 * on, and/or an explicit `to[]` (ownerIds / Brief 28 @-selectors / '*' /
 * 'human'). Delivery is policy-per-recipient: wake-awaiters on the key are
 * woken (durable, liveness-adaptive); the rest of `to[]` get one coord inbox
 * message (notify — never wakes).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitAwaitedEvent } from '../../events/await/engine';
import { sendMessage } from '../coordination/messages';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'events:emit',
  description:
    'Fire an event key through the await-event primitive: every agent with an events:await on the key is woken (durable delivery — pty-inject / session-resume / inbox ladder); an optional `to` list additionally receives a coord inbox notification (notify policy — never wakes). Use the key your waiter registered (events:await tells them what to wait on).',
  guidance: {
    when: 'Announcing that the thing a peer is blocked on has happened: their requested work is done, an artifact landed, a decision resolved. Pair with events:await — the waiter registers the key, you emit it. (To WAKE a parked AGENT — re-invoke its turn — the key is `coord:inbox-wake:<ownerId>`, but prefer the higher-level verbs that hide the key: coord:wake to nudge, coord:dispatch to assign+wake, coord:send {wake:\'required\'} to message+wake.)',
    notWhen:
      'General status narration — lifecycle auto-emits + work_items:complete already cover it. Conversation — coord:send. Waking a specific agent — use coord:wake / coord:dispatch (they fire the inbox-wake key for you + report woken/dead). If nobody could plausibly be awaiting the key and you have no `to`, the emit reaches no one (it is not a log).',
    chaining: 'Peer: events:await { event: K } → you: do the work → events:emit { event: K, summary } → peer wakes.',
    seeAlso: [
      'events:await (a peer waits with this before you emit)',
      'events:status (see pending awaits for the event)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: z.string().min(1).max(200).describe('Exact event key to fire.'),
    summary: softText(LIMITS.ANNOTATION).optional().describe('One human line — rides the wake turn / notify summary. Auto-truncated to 2000 chars if longer.'),
    payload: z.unknown().optional().describe('Structured data carried on the wake (truncated at 400 chars in the turn text).'),
    to: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Additional NOTIFY audience: ownerIds, @plan:/@topic:/@object:/@file: selectors, '*' or 'human'. Wake-awaiters are excluded (their wake already carries it)."),
    scope: z
      .enum(['hive', 'local'])
      .optional()
      .describe(
        "P-009 (cross-machine-coord-parity): 'hive' ALSO federates this event to every machine of the workspace's shared Hive — each peer re-fires the key into ITS local await store, so a REMOTE machine's events:await on the same key wakes (rendezvous beyond inbox-wake: lock grants, artifact-ready, staging-advanced). Requires a resolvable hive scope (the result reports federated: plus federation_error: when none). Omit/'local' = today's machine-local emit.",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const result = await emitAwaitedEvent({
      key: args.event,
      summary: clampText(args.summary, LIMITS.ANNOTATION),
      payload: args.payload,
      to: args.to,
      source: identity.ownerId,
      workspaceId: identity.workspaceId ?? undefined,
    });
    // ── P-009 (cross-machine-coord-parity-and-trust-2026-07-01): federate the
    // event. The fed-event rides a NO-RECIPIENT hive-scoped coord row (persists
    // + federates via the mig-150 gate; empty `to` = zero inbox noise, audience
    // D-004). Each peer's coord-message projection re-fires the key into its
    // local await store — only registered watchers wake (no thunder-herd), and
    // the per-author wake budget applies on the receiving side. Best-effort:
    // the LOCAL emit above already happened; a federation miss is reported,
    // never thrown.
    let federated: boolean | undefined;
    let federationError: string | undefined;
    if (args.scope === 'hive') {
      federated = false;
      try {
        const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
        const ctxHarness =
          typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*'
            ? ctxHarnessRaw
            : undefined;
        let scopeSlug = ctxHarness;
        if (!scopeSlug && identity.workspaceId && identity.workspaceId !== '*') {
          const resolved = await resolveWorkspaceHiveScope(identity.workspaceId);
          if (resolved.kind === 'one') scopeSlug = resolved.homeSlug;
          else federationError = resolved.kind === 'many' ? 'ambiguous_hive_scope' : 'no_hive_scope';
        } else if (!scopeSlug) {
          federationError = 'no_hive_scope';
        }
        if (scopeSlug) {
          // Bound the federated payload — a fed event is a signal, not a blob.
          let payload = args.payload;
          try {
            if (payload !== undefined && JSON.stringify(payload).length > 8_192) {
              payload = undefined;
              federationError = 'payload_too_large_dropped';
            }
          } catch {
            payload = undefined;
          }
          await sendMessage(identity, {
            to: [],
            summary: `[fed-event] ${args.event}`,
            harnessSlug: scopeSlug,
            extra: {
              fed_event: {
                key: args.event,
                ...(payload !== undefined ? { payload } : {}),
                ...(args.summary ? { summary: clampText(args.summary, LIMITS.ANNOTATION) } : {}),
                source: identity.ownerId,
              },
            },
          });
          federated = true;
        }
      } catch (e) {
        federationError = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            event: result.key,
            woken: result.woken,
            notified: result.notified.length,
            msg_id: result.msgId,
            ...(federated !== undefined ? { federated } : {}),
            ...(federationError ? { federation_error: federationError } : {}),
          }),
        },
      ],
    };
  },
});
