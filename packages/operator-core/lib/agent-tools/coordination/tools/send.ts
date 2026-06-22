/**
 * coord:send — send a typed message (or coord broadcast) to one or
 * more other agents. agent-coordination-architecture-v2 §6.4 (#6).
 *
 * Persists to the `messages` surface of the CoordEventLog (the operator
 * backs it with Postgres — harness_shared.coord_event_log). Recipients
 * see it via coord:inbox.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): the SINGLE form
 * { to, summary, … } sends ONE message (its `to` is a multi-RECIPIENT list — one
 * message to many addressees, unchanged). The NEW `items:[{ to, summary, … }]`
 * axis sends N DISTINCT messages in one call. Both return the house envelope
 * { ok, results:[{ ok, to, msg_id? … | error }], counts } — each result
 * self-describes its `to` (+ returned msg_id); one failed message never fails the
 * rest. All routing/recipient-resolve/wake/endTurn logic runs PER message.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type AgentIdentity } from '../identity';
import { sendMessage } from '../messages';
import { wakeRecipients, reportIdleRecipients } from '../inbox-wake';
import { resolveRecipients, isSelectorOrWildcard } from '../recipient-resolve';
import { COORD_ROLES } from '../roles';
import { forceEndTurn } from '../../turn/interrupt';
import { runBulk, bulkContent, type BulkItemResult } from '../../_bulk';

/** Settle window between an endTurn ESC and the following wake (coord-end-turn D-003): lets each recipient's
 *  CLI finish ending the dead turn + re-arm its `coord:inbox-wake:<owner>` watch before the wake fires, so
 *  the wake doesn't race the abort and land woken:0. Env-tunable. */
const ENDTURN_SETTLE_MS = Number(process.env.PAPERCUSP_ENDTURN_SETTLE_MS) || 1500;

/** One distinct message's full arg set (the new `items` axis carries N of these). */
interface SendMsg {
  to: string[];
  summary: string;
  body?: string;
  files?: string[];
  plan_slug?: string;
  related_msg_id?: string;
  wake?: boolean | 'required' | 'optimistic';
  endTurn?: boolean;
}

const wakeArg = z
  .union([z.boolean(), z.enum(['required', 'optimistic'])])
  .optional()
  .describe(
    "Wake a SLEEPING addressee NOW, not just inject. 'required' = the wake MUST land: a clean miss (no awake/watching session, none paused) returns recipient_absent:true — a loud miss to handle, not a silent ok. 'optimistic' = best-effort over a durable backstop (wake if present, shrug if not — e.g. the Queen survey re-dispatches anyway); a miss is silent. Omit = plain inject. Legacy boolean: true → 'required', false → no wake. Targeted to the addressees only — never a broadcast ('*'/'human' are skipped).",
  );

const endTurnArg = z
  .boolean()
  .optional()
  .describe(
    "ESC each addressee's CURRENT turn (mimic pressing Escape) BEFORE delivering — the dual of wake-as-Enter. Use ONLY when a recipient's turn is STUCK (e.g. wedged on an API error so a plain wake reaches nobody / typing+Enter won't start the next turn): the ESC ends the dead turn so the CLI re-arms, then (with wake) this message starts a fresh turn. Force-ESC is audited + storm-rate-limited; only end a turn you KNOW is stuck. Skips '*'/'human'/self.",
  );

const toArg = z
  .array(z.string().min(1), {
    error:
      'coord:send needs `to`: recipient ids. Accepts the SHORT HANDLE shown in the [coord+N] injection / inbox (e.g. "93a38"), the "su-…" prefix, OR the full ownerId — all resolve against the live roster, so NO coord:presence lookup is needed to reply to a peer. ["*"] broadcasts, ["human"] surfaces to the user. (To make a peer who is waiting on your reply act NOW rather than on their next turn, set wake:"required" — a plain send only injects.)',
  })
  .min(1, 'coord:send needs at least one recipient in `to` — ["*"] broadcasts, ["human"] surfaces to the user.');

const summaryArg = z
  .string({
    error:
      'coord:send needs `summary`: a one-line headline of the message (what the recipient sees in their inbox).',
  })
  .min(1, '`summary` must be a non-empty one-line headline.');

const itemSpec = z.object({
  to: toArg,
  summary: summaryArg,
  body: z.string().optional(),
  files: z.array(z.string()).optional(),
  plan_slug: z.string().optional(),
  related_msg_id: z.string().optional(),
  wake: wakeArg,
  endTurn: endTurnArg,
});

/**
 * Send ONE distinct message — the full per-message pipeline (recipient resolve →
 * endTurn → persist → wake / idle-report). Returns the self-describing result for
 * the bulk envelope: it embeds the message's `to` (its key) + the minted msg_id.
 * A recipient-resolve miss is this message's { ok:false } (it does NOT throw), so
 * one bad address never fails the other messages in the batch.
 */
async function sendOne(
  msg: SendMsg,
  identity: AgentIdentity,
  harnessSlug: string | undefined,
): Promise<BulkItemResult> {
  // Wake INTENT (directed-wake-honesty D-002): 'required' = the wake must land
  // (a clean miss → recipient_absent); 'optimistic' = best-effort over a durable
  // backstop (silent miss). Legacy boolean coerces: true → 'required' (the safe
  // loud default), false/omit → no wake.
  const wakeMode: 'required' | 'optimistic' | null =
    msg.wake === true ? 'required' : msg.wake === false || msg.wake == null ? null : msg.wake;

  // owner-2026-06-17: validate + resolve recipients against the live roster
  // BEFORE sending. A short ownerId PREFIX resolves to the full id (so the exact
  // `coord:inbox-wake:<ownerId>` wake key matches and the wake lands); a concrete
  // recipient that matches NO known agent is a LOUD error — the send does NOT
  // happen — instead of the old silent ok:true. Fail-soft: a roster-read hiccup
  // degrades to the raw ids (never blocks coord). Local-roster scoped.
  let toSend = msg.to;
  if (msg.to.some((id) => !isSelectorOrWildcard(id))) {
    try {
      const r = await resolveRecipients(msg.to, identity.workspaceId);
      if (r.unknown.length || r.ambiguous.length) {
        return {
          ok: false,
          to: msg.to,
          error: 'unknown_recipient',
          message:
            'coord:send addressed agent(s) not in the roster — nothing was sent. ' +
            'Use the short handle from [coord+N]/inbox, the su- prefix, or the full ownerId ' +
            '(coord:presence lists them); a substring of a live ownerId also resolves.',
          ...(r.unknown.length ? { unknown_recipients: r.unknown } : {}),
          ...(r.ambiguous.length ? { ambiguous_recipients: r.ambiguous } : {}),
        };
      }
      toSend = r.resolved;
    } catch (e) {
      console.warn(
        `[coord:send] recipient resolve failed, sending unresolved: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  const env = await sendMessage(identity, {
    to: toSend,
    summary: msg.summary,
    body: msg.body,
    files: msg.files,
    plan_slug: msg.plan_slug,
    related_msg_id: msg.related_msg_id,
    ...(harnessSlug ? { harnessSlug } : {}),
    // EI-279: persist the wake intent ON the envelope so it federates — a
    // recipient homed on a REMOTE instance is woken by the coord-message
    // projection's fan when the row arrives there (the local fan below only
    // covers THIS instance's await store).
    ...(wakeMode ? { extra: { wake: true } } : {}),
  });

  // endTurn (coord-end-turn P-002): ESC each addressed recipient's CURRENT turn BEFORE the wake. A turn
  // STUCK on an API error is NOT sleeping on its inbox-wake key, so a plain wake reaches nobody (woken:0);
  // the ESC ends the dead turn → the CLI returns to idle + re-arms its watch → the wake below starts a
  // fresh turn with this message. Force-ESC reuses turn:interrupt's audit + storm rate-limit; skips
  // '*'/'human'/self. Then SETTLE so the wake doesn't race the abort (D-003).
  let endTurn: { ended: string[]; missed: string[] } | undefined;
  if (msg.endTurn) {
    const targets = env.to.filter((id) => id !== '*' && id !== 'human' && id !== identity.ownerId);
    const ended: string[] = [];
    const missed: string[] = [];
    for (const owner of targets) {
      try {
        const r = await forceEndTurn({
          actor: identity.ownerId,
          workspaceId: identity.workspaceId ?? '*',
          owner,
          reason: msg.summary,
        });
        (r.ok ? ended : missed).push(owner);
      } catch {
        missed.push(owner);
      }
    }
    endTurn = { ended, missed };
    // Give each CLI a moment to finish ending its turn + re-arm its inbox-wake watch before we wake it.
    if (wakeMode && ended.length > 0) await new Promise((r) => setTimeout(r, ENDTURN_SETTLE_MS));
  }

  // Deliver-and-wake (P-040): the message already persisted to the inbox above
  // (the durable default). When the sender opted in, ALSO fire each addressed
  // recipient's OWN inbox-wake key so a SLEEPING addressee is re-invoked — one
  // targeted emit per ownerId, NEVER a broadcast key (P-042). We wake the
  // POST-expansion recipients (`env.to` — audience selectors already resolved),
  // so a `@plan:`/`@topic:` send wakes exactly the resolved set, not '*'.
  let wake:
    | {
        mode: 'required' | 'optimistic';
        targets: string[];
        woken: number;
        staged?: number;
        recipient_absent?: boolean;
        note?: string;
      }
    | undefined;
  if (wakeMode) {
    const fan = await wakeRecipients(env.to, {
      summary: msg.summary,
      source: identity.ownerId,
    });
    wake = { mode: wakeMode, targets: fan.targets, woken: fan.woken };
    if (fan.staged > 0) wake.staged = fan.staged;
    // P-002/P-005: a REQUIRED directed wake that reached wakeable addressees
    // (`targets` already excludes '*'/'human') yet woke nobody AND deferred
    // nobody (Pause/manual staging) is a loud miss — recipient_absent, replacing
    // the old silent woken:0 warning. OPTIMISTIC misses stay silent (P-004: the
    // inbox row persisted regardless; a durable backstop picks it up).
    if (wakeMode === 'required' && fan.targets.length > 0 && fan.woken === 0 && fan.staged === 0) {
      wake.recipient_absent = true;
      wake.note =
        `required wake reached no awake/watching session for: ${fan.targets.join(', ')} — ` +
        'the message was injected to their inbox (seen on their next natural turn), but no session was re-invoked now.';
    }
  }

  // Default (no-wake / inject-only) path — REPORT idle recipients
  // (coord-dispatch-reliability-2026-06-21 P-001). A plain send lands in the
  // inbox but does NOT re-invoke a sleeping agent, so a hand-off injected to an
  // idle agent silently stalls. We NON-FIRINGLY probe each concrete addressee's
  // inbox-wake key (report-only — NEVER a wake on this path, invariant a) and
  // surface the ones no live session is watching, so the sender can re-send with
  // wake:'required' instead of assuming pickup. Fully fail-soft: a roster /
  // await-store hiccup degrades to no report — the send already succeeded
  // (invariant c), so this never blocks or fails it. We probe the SAME
  // post-expansion set the wake fan would (`env.to`), so a `@plan:`/`@topic:`
  // send reports exactly the resolved recipients, never '*'.
  let notWoken: { idleRecipients: string[]; note: string } | undefined;
  if (!wakeMode) {
    const report = await reportIdleRecipients(env.to, { workspaceId: identity.workspaceId ?? undefined });
    if (report.idle.length > 0) {
      notWoken = {
        idleRecipients: report.idle,
        note:
          `injected to ${report.idle.join(', ')} — no live session is watching their inbox, so this send does NOT ` +
          'wake them (seen on their next natural turn, if any). To hand off live work that must be picked up now, ' +
          "re-send with wake:'required' and verify pickup (woken / recipient_absent).",
      };
    }
  }

  return {
    ok: true,
    to: env.to,
    msg_id: env.msg_id,
    ts: env.ts,
    ...(endTurn ? { endTurn } : {}),
    ...(wake ? { wake } : {}),
    ...(notWoken ? { notWoken } : {}),
  };
}

export default defineTool({
  name: 'coord:send',
  description:
    'Send a message to other coordination agents — ONE message (single form) OR N distinct messages (items:[…]). `to` is ownerIds; ["*"] broadcasts, ["human"] surfaces to the user. Default: INJECTED — lands in the recipient\'s inbox, seen next turn (cheap). `wake:\'required\'` ALSO re-invokes a sleeping recipient now; a miss (reached nobody) returns recipient_absent:true. `wake:\'optimistic\'` = silent best-effort wake over a durable backstop. Single: { to, summary, body?, wake?, … }. Many distinct messages: items:[{ to, summary, body?, wake?, … }]. Returns { ok, results:[{ ok, to, msg_id? … | error }], counts } — correlate each result by its `to` (+ msg_id), not by position; one failed message never fails the rest.',
  guidance: {
    when: 'Sharing context, asking a question, or handing off work. Send several DISTINCT messages at once via items:[…] instead of looping. wake:\'required\' ONLY when the recipient is idle and MUST act now (a Queen waking a sleeping bee) — a miss returns recipient_absent. wake:\'optimistic\' when a durable backstop catches a miss (the Queen survey re-dispatches). A running recipient already sees the inject mid-turn — a wake is wasted on it.',
    notWhen: 'For an in-conversation reply to the human, just speak. For locking a file, use locks:acquire — coord:send is async/eventual, not a lock. Don\'t set a wake for routine/ambient notes — a wake is a billable turn (unify-watch D-002: inject is the default, wake is the deliberate opt-in). For ONE message to MANY recipients, use the single form with `to:[…]` — `items` is the "many distinct messages" axis, not the multi-recipient one.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      // Caller-DX (watchdog P-006): actionable validation messages — agents
      // repeatedly bounced off the bare "Required" / "Array must contain at least
      // 1 element(s)" zod default on these two required fields.
      to: toArg.optional(),
      summary: summaryArg.optional(),
      body: z.string().optional(),
      files: z.array(z.string()).optional(),
      plan_slug: z.string().optional(),
      related_msg_id: z.string().optional(),
      wake: wakeArg,
      endTurn: endTurnArg,
      items: z
        .array(itemSpec)
        .min(1)
        .max(100)
        .optional()
        .describe('send many DISTINCT messages at once — each { to, summary, body?, files?, plan_slug?, related_msg_id?, wake?, endTurn? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || ((a.to?.length ?? 0) > 0 && Boolean(a.summary)), {
      message: 'pass { to, summary } for one message, or items:[{ to, summary }] for many distinct messages',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Record the sender's harness when it's a real, harness-scoped agent
    // (pipeline roles carry ctx.harnessSlug). '*'/empty = operator/SU/oracle
    // wildcard ⇒ workspace-level (broadcast); leave harness unset there.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;

    const list: SendMsg[] = args.items?.length
      ? args.items.map((it) => ({ ...it }))
      : [
          {
            to: args.to as string[],
            summary: args.summary as string,
            body: args.body,
            files: args.files,
            plan_slug: args.plan_slug,
            related_msg_id: args.related_msg_id,
            wake: args.wake,
            endTurn: args.endTurn,
          },
        ];
    const env = await runBulk(list, (msg) => sendOne(msg, identity, harnessSlug), {
      keyOf: (msg) => ({ to: msg.to }),
    });
    return bulkContent(env);
  },
});
