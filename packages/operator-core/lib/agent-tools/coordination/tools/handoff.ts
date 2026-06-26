/**
 * coord:handoff — record a work transition between agents.
 *
 * Writes a per-event file at coord/handoffs/<msg_id>.json. Acceptance
 * is a sibling file written by the receiver (also via coord:handoff
 * with an `accept_msg_id` arg) or auto-emitted when the receiver
 * calls plans:set-now on the same plan (a planned future bolt-on).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { openHandoff, acceptHandoff } from '../handoffs';
import { resolveBestEffortAgainstRoster } from '../recipient-resolve';
import { wakeRecipients, reportIdleRecipients } from '../inbox-wake';
import { describeMissedRecipients, type MissedRecipientLiveness } from '../recipient-liveness';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:handoff',
  description:
    'Record a work transition. Either OPEN a new handoff to other agents (provide `to[]`, `plan_slug`, `summary`, etc.) OR ACCEPT an existing one by passing `accept_msg_id` alone.',
  guidance: {
    when: 'Wrapping up your piece of a plan and naming who picks up next — or accepting a handoff someone made to you.',
    notWhen: 'A routine status update — use coord:send. A blocking decision — use coord:escalate.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    accept_msg_id: z
      .string()
      .optional()
      .describe('Pass to accept an existing handoff; takes precedence over the open-handoff fields.'),
    to: z.array(z.string().min(1)).optional(),
    plan_slug: z.string().optional(),
    summary: z.string().optional(),
    body: z.string().optional(),
    next_action: z.string().optional(),
    files_modified: z.array(z.string()).optional(),
    commit: z.string().optional(),
    note: z.string().optional().describe('Free-form note when accepting.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.accept_msg_id) {
      const rec = await acceptHandoff(identity, args.accept_msg_id, args.note);
      if (!rec) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'not_found',
                detail: `no handoff with msg_id=${args.accept_msg_id}`,
              }),
            },
          ],
          isError: true,
        };
      }
      // await-event-primitive-2026-06-05 P-015: a sleeping offerer wakes on
      // `handoff:accepted:<msg_id>`; the accept message already covers notify.
      void import('../../../events/await/engine')
        .then(({ emitAwaitedEvent }) =>
          emitAwaitedEvent({
            key: `handoff:accepted:${args.accept_msg_id}`,
            summary: `handoff ${args.accept_msg_id} accepted by ${identity.ownerId}`,
            payload: { msg_id: args.accept_msg_id, acceptor: identity.ownerId },
            source: identity.ownerId,
          }),
        )
        .catch(() => {});
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, accepted: rec }) },
        ],
      };
    }
    if (!args.to || !args.plan_slug || !args.summary) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'missing_fields',
              detail: 'open-handoff requires to[], plan_slug, summary',
            }),
          },
        ],
        isError: true,
      };
    }
    // owner-2026-06-17: resolve short ownerId prefixes to full ids so the handoff
    // records + reaches the right agent. Best-effort + fail-soft.
    const handoffTo = await resolveBestEffortAgainstRoster(args.to, identity.workspaceId);
    const rec = await openHandoff(identity, {
      to: handoffTo,
      plan_slug: args.plan_slug,
      summary: args.summary,
      body: args.body,
      next_action: args.next_action,
      files_modified: args.files_modified,
      commit: args.commit,
    });

    // coord-dispatch-reliability P-003 (wake-on-open): opening a handoff previously
    // only INJECTED to the recipient's inbox — an IDLE recipient never woke, never
    // accepted, and so the offerer's own accept-wake (`handoff:accepted:<id>`) never
    // fired → a silent stall. Now we WAKE the resolved recipient(s) so a sleeping
    // addressee gets a turn to accept, starting the accept→wake-offerer chain.
    //   - SINGLE-TARGET, never a broadcast: wakeRecipients fires one inbox-wake key
    //     per concrete ownerId and skips the SAME NON_WAKEABLE/selector targets the
    //     coord:send wake fan skips ('*'/'human'/empty/@selectors) — no thunder-herd.
    //   - FAIL-SOFT: the handoff is ALREADY durably recorded above; a wake-fan hiccup
    //     must NEVER fail the open (the recipient still sees it on their next natural
    //     turn). Any error here degrades to "no liveness reported".
    //   - LIVENESS surfaced (parallel to P-001's coord:send notWoken): the offerer
    //     learns whether anyone was actually re-invoked, so a handoff that woke
    //     nobody (recipient_absent) is a loud miss they can react to, not a silent one.
    let wake:
      | {
          targets: string[];
          woken: number;
          staged?: number;
          recipient_absent?: boolean;
          /** FF#2: missed addressees with NO live session watching their inbox — genuinely
           *  dead, the handoff black-holes until they're relaunched (mirrors coord:send WI-574). */
          recipient_dead?: string[];
          /** FF#3: each missed addressee's FRESH session state at the open moment. */
          recipient_liveness?: MissedRecipientLiveness[];
          note?: string;
        }
      | undefined;
    try {
      const fan = await wakeRecipients(handoffTo, {
        summary: args.summary,
        source: identity.ownerId,
        workspaceId: identity.workspaceId ?? undefined,
      });
      wake = { targets: fan.targets, woken: fan.woken };
      if (fan.staged > 0) wake.staged = fan.staged;
      // A handoff aimed at concrete, wakeable addressee(s) that woke nobody AND
      // staged nobody is a loud miss (mirrors coord:send wake:'required'): the
      // handoff injected to their inbox, but no session was re-invoked to accept it.
      if (fan.targets.length > 0 && fan.woken === 0 && fan.staged === 0) {
        wake.recipient_absent = true;
        // FF#2/FF#3: classify the dead ones + force their fresh session state into the
        // result, so a handoff to a long-ended agent isn't read as "offered, all good".
        let dead: string[] = [];
        try {
          dead = (await reportIdleRecipients(fan.targets, { workspaceId: identity.workspaceId ?? undefined })).idle;
        } catch {
          /* fail-soft */
        }
        if (dead.length > 0) wake.recipient_dead = dead;
        try {
          const liveness = await describeMissedRecipients(fan.targets);
          if (liveness.length > 0) wake.recipient_liveness = liveness;
        } catch {
          /* fail-soft */
        }
        wake.note =
          (dead.length > 0
            ? `handoff opened, but NO live session is watching the inbox of: ${dead.join(', ')} — they are not running, so this offer black-holes until they are relaunched (NOT "seen on their next turn"). `
            : `handoff opened, but no awake/watching session was re-invoked for: ${fan.targets.join(', ')} — it is in their inbox (seen on their next natural turn). `) +
          'A handoff is NOT a pickup: it is pending until accepted (accepted:false below). If this work must ' +
          "be picked up now, re-dispatch to a LIVE agent (coord:presence → wakeable:true) or coord:send wake:'required'. " +
          '(A 30m re-ping backstop will nudge you if it stays un-acked; a 12h sweep auto-expires it.)';
      }
    } catch (e) {
      // The open already succeeded; a wake failure is non-fatal. Report nothing.
      console.warn(
        `[coord:handoff] wake-on-open for ${rec.msg_id} failed (handoff still recorded): ${e instanceof Error ? e.message : e}`,
      );
    }

    return {
      content: [
        {
          type: 'text' as const,
          // FF#2 — a freshly-opened handoff is NEVER "done": it is PENDING acceptance.
          // accepted:false makes that explicit in the result so the offerer can't read a
          // successful OPEN as a successful TRANSFER; the accept→wake-back + reconcile sweep
          // close the loop. Mirrors the "verify pickup, don't assume" discipline.
          text: JSON.stringify({
            ok: true,
            msg_id: rec.msg_id,
            ts: rec.ts,
            accepted: false,
            pending_acceptance: true,
            ...(wake ? { wake } : {}),
          }),
        },
      ],
    };
  },
});
