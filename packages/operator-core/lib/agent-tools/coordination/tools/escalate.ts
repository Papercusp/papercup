/**
 * coord:escalate — raise an escalation to the human.
 *
 * The channel that earns the right to interrupt. Use sparingly — only
 * for decisions the agent should not make alone. The UI surfaces open
 * escalations prominently; coord:resolve closes them out.
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): the open
 * escalation also fires a `coord:emit` lifecycle notification to the plan's
 * watchers (the openEscalation record itself is addressed `to: ['human']`
 * only, so this is additive, not a duplicate). The Queen's default wake
 * subscription rides the same tool event (lib/hive/wake-defaults).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { armEscalationRequesterInterest, openEscalation } from '../escalations';
import { EVIDENCE_BANDS } from '../relay-provenance';
import { COORD_ROLES } from '../roles';
import { softText, clampText, LIMITS } from '../../limits';
import { isAgentSessionSender } from '../machine-authored';
import { fetchHolderGoalRecord } from '../agent-goal-sources';

const SEVERITY = ['blocker', 'question', 'advisory'] as const;

export default defineTool({
  name: 'coord:escalate',
  description:
    'Raise an escalation to the human. Provide severity (blocker | question | advisory), a one-line summary, and optionally a body and a small list of choice options to make resolution one click.',
  guidance: {
    when: 'A decision you should not make alone, a blocker that requires human input, or a risky operation that needs explicit confirmation.',
    notWhen: 'Routine status updates — use coord:send. File contention — locks:queue already names the holder.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // The launch-fixer roles (merge-resolver / release-fixer / content-fixer) each
  // declare coord:escalate in their blueprint deps as their "can't safely fix → hand
  // to a human" escape hatch, but none are in COORD_ROLES — so a spawned fixer's
  // escalate hit role_not_allowed (a declared-but-ungated dependency). Granted HERE
  // only (least-privilege: just escalate, not the whole coord:* surface). The fixers'
  // primary human-surfacing is still their system routine's own escalation; this
  // makes the agent's richer per-file escalation actually fire. (git-sync-content-guard
  // D-008; fixes the inherited merge-resolver/release-fixer gap in the same edit.)
  agentRoles: [...COORD_ROLES, 'merge-resolver', 'release-fixer', 'content-fixer'],
  // Demand surfaces as an EVENT (start-hive-wake P-001 / D-001). The escalation
  // record goes to the human; this lifecycle emit reaches the plan's watchers
  // ([] when plan-less ⇒ recorded, delivered to no inbox — audit without noise).
  emits: [
    {
      fire: 'coord:emit',
      when: (e) => Boolean((e.result?.data as { ok?: boolean } | undefined)?.ok),
      render: (e) => {
        const a = e.args as { severity?: string; summary?: string; plan_slug?: string };
        return {
          category: 'escalation',
          summary: `escalation (${a.severity ?? '?'}): ${a.summary ?? ''}`,
          ...(a.plan_slug ? { plan_slug: a.plan_slug, to: [`@plan:${a.plan_slug}`] } : { to: [] }),
        };
      },
    },
  ],
  args: z.object({
    severity: z.enum(SEVERITY),
    summary: softText(LIMITS.ANNOTATION, { min: 1 }).describe(
      'One-line summary of the escalation — auto-truncated to 2000 chars if longer.',
    ),
    body: z.string().optional(),
    plan_slug: z.string().optional(),
    conditionKey: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Stable identifier for a RECURRING condition (e.g. "mug-placement-stall", "work-feed-dead"). Re-escalating the same conditionKey COALESCES onto the existing open row (bumps its repeatCount) instead of opening a new one; the response reports coalesced:true and bodyDiscarded:true when the new text is not persisted. Pass it for any watchdog/monitor condition you re-check on a cadence — especially when the summary embeds a live count or duration ("stalled ~7h", "302 items"), because without it the dedup falls back to the prose summary, which never repeats, and every wake leaks a new permanently-open escalation.',
      ),
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional()
      .describe('Optional named choices the human can pick from. Omit for free-form.'),
    evidence: z
      .object({
        band: z.enum(EVIDENCE_BANDS),
        reportedBy: z.string().min(1).optional(),
        ref: z.string().min(1).max(200).optional(),
      })
      .optional()
      .describe(
        'How this escalation is GROUNDED: observed (you saw it) | tool-output (a tool result backs it; pass `ref`) | reported-by (a peer told you; `reportedBy` REQUIRED) | inferred (reasoned, not witnessed) | assumed (working assumption). Confidence is DERIVED from the band and rendered for the reader — never pass a number, it is discarded and flagged.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Record the escalating agent's harness (pipeline roles carry it) so the
    // human inbox can open a chat scoped to it. '*'/empty = operator/SU/oracle
    // wildcard ⇒ workspace-level escalation; leave harness unset there.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
    // A caller-supplied conditionKey becomes the dedup subjectSignature, so the SAME
    // recurring condition coalesces onto one open row across firings. Without it the
    // signature is derived from the prose summary — and a watchdog whose summary carries
    // a live count/duration never produces the same signature twice, so every re-check
    // leaked a NEW permanently-open escalation (162 of papercusp's 193 open rows were
    // this: the kettle re-filing "Mug stalled ~7h" → "~10h" → "~16h" once per wake).
    // Same flood class as EI-1490 (placement-watchdog) and EI-6789 (steering-lease),
    // whose senders were excluded wholesale; a stable key fixes it at the source instead,
    // keeping a genuinely-live condition visible (and countable) as exactly one row.
    // owner-inbox-single-pane D-015: attach the authoritative goal the agent is
    // actually holding, rather than asking every caller to remember another
    // correlation argument. The shared state-plane resolver already reconciles
    // work-item, plan-item, fleet and explicit-override legs. Only an unambiguous
    // WI-/EI-/F- or <plan>#P-NNN goal is lifecycle-linkable; a divergent/fleet/
    // unknown goal stays unlinked and therefore can never be auto-resolved.
    let goalRef: string | null = null;
    if (isAgentSessionSender(identity.ownerId)) {
      const goal = await fetchHolderGoalRecord(identity.ownerId).catch(() => null);
      const candidate = goal?.itemId?.trim() ?? '';
      if (
        goal &&
        goal.agreement !== 'divergent' &&
        // `competing` is `readonly string[] | null` and documented "Absent ⇒ []"
        // (holder-context.ts D-093/D-092), so a missing leg means NO competing
        // claims — not an unknown one. Optional-chain rather than assert.
        (goal.competing?.length ?? 0) === 0 &&
        (/^(?:WI|EI|F)-\d+$/i.test(candidate) || /#P-\d+$/i.test(candidate))
      ) {
        goalRef = candidate;
      }
    }
    const meta = {
      ...(harnessSlug ? { harnessSlug } : {}),
      ...(args.conditionKey ? { subjectSignature: args.conditionKey.trim() } : {}),
      ...(goalRef ? { goalRef } : {}),
    };
    const rec = await openEscalation(identity, {
      severity: args.severity,
      summary: clampText(args.summary, LIMITS.ANNOTATION),
      body: args.body,
      plan_slug: args.plan_slug,
      options: args.options,
      // P-010: a `reported-by` band with no attribution is rejected at READ time
      // (an unattributed relay is the provenance collapse the band exists to
      // stop), so drop it here rather than persist a stamp that will never read
      // back. DESCRIPTIVE only (D-015) — it never affects what the runtime does.
      ...(args.evidence && (args.evidence.band !== 'reported-by' || args.evidence.reportedBy)
        ? { evidence: args.evidence }
        : {}),
      // harnessSlug (a concrete harness, never '*') does double duty: meta.harnessSlug
      // scopes the human-inbox chat (existing), and harness_slug FEDERATES the record
      // so a peer-machine harness-scoped escalation reaches the hub where the human's
      // inbox lives (WI-1375; mirrors messages.ts + coord:handoff). Operator/SU
      // ('*'/unset) escalations stay workspace-local.
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(harnessSlug ? { harness_slug: harnessSlug } : {}),
    });
    const interestWatch = await armEscalationRequesterInterest(identity.ownerId, rec.msg_id);
    const coalesced = rec.coalesced === true;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...(coalesced
              ? {
                  notice: 'COALESCED: existing escalation retained; this call\'s summary/body/options were discarded.',
                  coalesced: true,
                  existingMsgId: rec.existingMsgId ?? rec.msg_id,
                  bodyDiscarded: rec.bodyDiscarded ?? true,
                }
              : {}),
            ok: true,
            msg_id: rec.msg_id,
            ts: rec.ts,
            interest_watch: interestWatch,
          }),
        },
      ],
    };
  },
});
