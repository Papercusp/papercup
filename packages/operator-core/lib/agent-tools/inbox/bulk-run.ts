/**
 * inbox:bulk-run-* — the resolver agent's interface to a BULK RESOLVE run
 * (inbox-bulk-resolve-2026-08-23, P-003).
 *
 * The owner clicks the Inbox pane's command strip; the server creates a run over
 * the exact items the pane was displaying and launches ONE resolver agent
 * (D-002). These three tools are that agent's whole contract:
 *
 *   inbox:bulk-run-manifest — what am I working on? (the run + its items, each
 *       with the LIVE `actions` the item currently offers, which is what makes a
 *       recommendation checkable rather than invented)
 *   inbox:bulk-run-report   — record what I did / what I recommend (bulk, the
 *       house keyed-array contract)
 *   inbox:bulk-run-settle   — I am done; work out from the item rows whether the
 *       owner has anything left to review
 *
 * TWO INVARIANTS LIVE HERE, deliberately, rather than in the agent's prompt —
 * a prompt cannot enforce anything:
 *
 *  1. **A recommended/dispatched action id must be one the item actually
 *     offers.** The resolver sees each item's real `actions` in the manifest and
 *     `report` REJECTS an id that is not among them (Requirement 5). A
 *     hallucinated option id would otherwise reach the owner's review list
 *     pre-selected and one click from being dispatched.
 *  2. **A navigate id is never a resolution.** `discuss` / `answer` / `open` /
 *     `chat` / `view-log` open a sub-surface and change nothing server-side;
 *     accepting one as an `auto_resolved` outcome would report work that never
 *     happened. This is the same class as the EI-13037 Discuss incident, where a
 *     navigate id missing from the navigate set silently resolved real owner
 *     gates.
 */

import { z } from 'zod';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { defineTool } from '@papercusp/agent-mcp';
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { softText, clampText, LIMITS } from '../limits';
import {
  getRun,
  getActiveRun,
  getRunItems,
  reportOutcomes,
  setRunPhase,
  settleRunPhase,
  type BulkOutcomeReport,
} from '../../attention/bulk-run-store';
import { upsertTriage } from '../../attention/triage-store';

/**
 * WI-41021 — the resolver's own verbs have to honour the kill switch.
 *
 * The feature flag used to be read in exactly two places: the client strip
 * (InboxPane's useFlag) and the owner's HTTP route. Neither is on the path an
 * ALREADY-LAUNCHED resolver takes — it drives its run entirely through the three
 * tools in this file. So flipping the feature off stopped the next start and did
 * nothing at all to the agent that was already acting on the owner's inbox.
 *
 * The rule, matching the route: the flag gates ACTING, never STOPPING.
 *   - manifest: on OFF, report the run as `stopped` (below). This reuses the
 *     WI-41013 halt signal the resolver already obeys, so the flag revokes
 *     in-flight authority through machinery that exists rather than a new
 *     channel. Deliberately NOT a refusal — a refused manifest read leaves the
 *     resolver blind, and a blind resolver keeps acting on stale item state.
 *   - report: on OFF, refuse the write, same shape as a settled run.
 *   - settle: NEVER gated. It is the wind-down path; refusing it would strand
 *     runs in `running` forever, which is the same inversion one level down.
 */
async function bulkResolveEnabled(): Promise<boolean> {
  // Fail CLOSED on a flag-backend error: getFlag already falls back to
  // FLAG_DEFAULTS, and "we cannot verify the kill switch" must read as stopped,
  // never as licence to keep taking terminal actions on the owner's inbox.
  return await getFlag(FLAGS.INBOX_BULK_RESOLVE, 'system:inbox-bulk-run').catch(() => false);
}

/**
 * Action ids that open a sub-surface instead of resolving anything.
 *
 * Re-exported from the canonical declaration in `../../attention/types`, which
 * the client card re-exports too. This used to be a second hand-maintained
 * copy kept in lockstep with the client's by a test that parsed the other
 * file's source; there is now ONE set, so that drift is no longer expressible.
 */
import { NAVIGATE_ACTION_IDS, isNavigateAction } from '../../attention/types';

export { NAVIGATE_ACTION_IDS, isNavigateAction };

/** An attention item as the manifest presents it to the resolver. */
interface ManifestItem {
  itemId: string;
  position: number;
  kind: string | null;
  title: string | null;
  ref: Record<string, unknown>;
  ownerAgentId: string | null;
  outcome: string;
  /** The option ids this item genuinely offers, split by what they DO. */
  actions: { id: string; label: string; terminal: boolean }[];
  /** Already-reported disposition, so a resumed resolver does not redo work. */
  reported: { actionId: string | null; rationale: string | null; confidence: string | null } | null;
}

/**
 * Read an item's live actions from the attention feed. Returns null when the
 * item is no longer in the feed at all — which is itself a finding (the ask went
 * away while the run was queued), not an error.
 */
async function liveActionsFor(
  itemId: string,
): Promise<{ id: string; label: string; terminal: boolean }[] | null> {
  try {
    const { callPlansRead } = await import('../plans/read-dispatch');
    const r = (await callPlansRead('attention', {})) as { groups?: { items?: unknown[] }[] };
    const groups = Array.isArray(r?.groups) ? r.groups : [];
    for (const g of groups) {
      for (const raw of g?.items ?? []) {
        const it = raw as { id?: string; actions?: { id?: string; label?: string }[] };
        if (it?.id !== itemId) continue;
        return (it.actions ?? [])
          .filter((a) => typeof a?.id === 'string')
          .map((a) => ({
            id: String(a.id),
            label: String(a.label ?? a.id),
            terminal: !isNavigateAction(String(a.id)),
          }));
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve which run the caller means: an explicit id, else the active one. */
async function resolveRunId(runId?: string): Promise<string | null> {
  if (runId) return runId;
  const active = await getActiveRun();
  return active?.runId ?? null;
}

export const bulkRunManifest = defineTool({
  name: 'inbox:bulk-run-manifest',
  description:
    'Read the BULK RESOLVE run you were launched for: the run row (phase, counters, the owner\'s filter provenance) plus every item in it with the LIVE options that item currently offers. Omit `runId` to get the workspace\'s active run. Each item carries `actions:[{ id, label, terminal }]` — `terminal:true` options RESOLVE the item, `terminal:false` ones only open a sub-surface and resolve nothing. You may only report an action id that appears in that list. An item whose `actions` come back EMPTY is not resolvable right now (its detail has not loaded, or it left the feed) — report it `skipped` with that reason rather than guessing.',
  guidance: {
    when: 'FIRST call when you are woken as a bulk-resolve resolver — it tells you what you are working on and what each item can actually do. Re-read it after a consult reply lands to pick up any item whose options changed.',
    notWhen:
      'Acting on a single attention item outside a run (use the item\'s own verb: coord:resolve, plans:set-status, inbox:triage). Reading the human inbox generally → plans:attention.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional().describe('the run to read; omit for the workspace\'s active run'),
    includeReported: z
      .boolean()
      .optional()
      .describe('include items already reported (default false — you normally want only what is left)'),
  }),
  async handler(args) {
    const featureEnabled = await bulkResolveEnabled();
    const runId = await resolveRunId(args.runId);
    if (!runId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_active_run',
              hint: 'No bulk-resolve run is active in this workspace. Nothing to do — end your turn.',
            }),
          },
        ],
      };
    }

    const run = await getRun(runId);
    if (!run) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: 'run_not_found', runId }) },
        ],
      };
    }

    const rows = await getRunItems(runId);
    const wanted = args.includeReported ? rows : rows.filter((r) => r.outcome === 'pending');

    const items: ManifestItem[] = [];
    for (const r of wanted) {
      const actions = (await liveActionsFor(r.itemId)) ?? [];
      items.push({
        itemId: r.itemId,
        position: r.position,
        kind: r.kind,
        title: r.title,
        ref: r.ref,
        ownerAgentId: r.ownerAgentId,
        outcome: r.outcome,
        actions,
        reported:
          r.outcome === 'pending'
            ? null
            : { actionId: r.actionId, rationale: r.rationale, confidence: r.confidence },
      });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            run: {
              runId: run.runId,
              phase: run.phase,
              totalItems: run.totalItems,
              autoResolved: run.autoResolved,
              recommended: run.recommended,
              skipped: run.skipped,
              failed: run.failed,
              filter: run.filterSnapshot,
              requestedBy: run.requestedBy,
            },
            items,
            remaining: rows.filter((r) => r.outcome === 'pending').length,
            // WI-41021 — a run is ALSO stopped when the owner flips the feature
            // off underneath you. The flag is the kill switch; you are a separate
            // process that would otherwise never notice it moved, so it reaches
            // you through this same `stopped` bit rather than a second channel.
            featureDisabled: !featureEnabled,
            // WI-41013 — the owner's Stop settles the run row; you are a
            // separate process and will not otherwise notice. When this is
            // true the run is NO LONGER YOURS: stop immediately, take no
            // further terminal action on any item, and do not report. Reports
            // for a stopped run are refused, and a refusal after you have
            // already acted means the action happened with nothing recording
            // it — which is exactly the state to avoid.
            stopped: !featureEnabled || !['pending', 'running'].includes(run.phase),
          }),
        },
      ],
    };
  },
});

const OutcomeItem = z
  .object({
    itemId: z.string().min(1),
    outcome: z.enum(['auto_resolved', 'recommended', 'skipped', 'failed']),
    actionId: z
      .string()
      .min(1)
      .optional()
      .describe('the option id you dispatched (auto_resolved) or pre-select for the owner (recommended). MUST be one the item offers.'),
    rationale: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('≤2 sentences of WHY — the audit note on an auto_resolved item, and what the owner reads on a recommended one'),
    draftAnswer: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('a drafted free-text reply where the resolution path takes prose, so the owner edits rather than composes'),
    confidence: z
      .enum(['low', 'high'])
      .optional()
      .describe("'high' = settled from direct evidence or the asker's own reply; 'low' = a consult deadline lapsed and you inferred it anyway"),
    consulted: z.boolean().optional().describe('true when you sent the asking agent a directed consult about this item'),
    consultReply: softText(LIMITS.ANNOTATION).optional().describe("the asker's reply, verbatim, when one arrived"),
    error: softText(LIMITS.ANNOTATION).optional().describe('why it was skipped, or how the dispatch failed — never leave this blank on skipped/failed'),
  })
  .refine((d) => d.outcome === 'skipped' || d.outcome === 'failed' || !!d.actionId, {
    message: 'actionId is required for auto_resolved and recommended outcomes',
    path: ['actionId'],
  })
  .refine((d) => !(d.outcome === 'skipped' || d.outcome === 'failed') || !!d.error?.trim(), {
    message: 'error (the why) is required when skipping or failing an item',
    path: ['error'],
  })
  .refine((d) => d.outcome !== 'auto_resolved' || !!d.rationale?.trim(), {
    message: 'rationale is required on auto_resolved — it is the audit note for an action taken on the owner\'s behalf',
    path: ['rationale'],
  });

export const bulkRunReport = defineTool({
  name: 'inbox:bulk-run-report',
  description:
    'Report per-item outcomes for a BULK RESOLVE run. `auto_resolved` = you took the terminal action (rationale REQUIRED — it is the audit note for something done on the owner\'s behalf, and an attention_triage record is written alongside it); `recommended` = pre-select an option for the owner\'s review list with a ≤2-sentence why; `skipped` / `failed` = record the reason, never a blank. An `actionId` that the item does not actually offer, or that only opens a sub-surface (discuss/answer/open/chat/view-log), is REJECTED for that item alone — the rest still land. Re-reporting the same item overwrites it (that is the intended path when a consulted asker answers late); the run counters are derived from the rows, never incremented, so it cannot double-count.',
  guidance: {
    when: 'After deciding each item in a bulk-resolve run. Batch several via `items:[…]` rather than one call per item.',
    notWhen:
      'Ending the run (inbox:bulk-run-settle). Triaging an attention item outside a run (inbox:triage).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      runId: z.string().min(1).optional().describe('the run; omit for the active one'),
      itemId: z.string().min(1).optional().describe('single-item shorthand'),
      outcome: z.enum(['auto_resolved', 'recommended', 'skipped', 'failed']).optional(),
      actionId: z.string().min(1).optional(),
      rationale: softText(LIMITS.ANNOTATION).optional(),
      draftAnswer: softText(LIMITS.ANNOTATION).optional(),
      confidence: z.enum(['low', 'high']).optional(),
      consulted: z.boolean().optional(),
      consultReply: softText(LIMITS.ANNOTATION).optional(),
      error: softText(LIMITS.ANNOTATION).optional(),
      items: z.array(OutcomeItem).min(1).max(100).optional().describe('outcomes to record (1–100)'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.itemId) && Boolean(a.outcome)), {
      message: 'pass `{ itemId, outcome }` (one) or `items:[{ itemId, outcome }]` (many)',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'no_active_run' }) }],
      };
    }

    // WI-41021 — the owner flipped the kill switch. Refuse BEFORE any write, and
    // in the same shape as a stopped run (below), because to the resolver these
    // are the same event: its authority to act was revoked mid-run. Distinct
    // `refused` reason so an operator reading a log can tell a flag flip from an
    // owner Stop without guessing.
    if (!(await bulkResolveEnabled())) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: 'feature_disabled',
              flag: FLAGS.INBOX_BULK_RESOLVE,
              runId,
              wrote: 0,
              message:
                "Bulk resolve has been turned OFF by the owner while this run was in flight. Nothing from this report was written. STOP: take no further action on any item in this run, and do NOT re-route the work to the item's own verb outside the run. If you already took an action before this refusal, say so plainly in your final message rather than retrying or hiding it.",
            }),
          },
        ],
      };
    }

    const reports = args.items?.length
      ? args.items
      : [
          {
            itemId: args.itemId!,
            outcome: args.outcome!,
            actionId: args.actionId,
            rationale: args.rationale,
            draftAnswer: args.draftAnswer,
            confidence: args.confidence,
            consulted: args.consulted,
            consultReply: args.consultReply,
            error: args.error,
          } as z.infer<typeof OutcomeItem>,
        ];

    // Validate each proposed action id against what the item ACTUALLY offers,
    // before anything is written. A bad id fails only its own item.
    const accepted: BulkOutcomeReport[] = [];
    const env = await runBulk(
      reports,
      async (r) => {
        if (r.actionId) {
          const actions = await liveActionsFor(r.itemId);
          if (actions && actions.length > 0) {
            const match = actions.find((a) => a.id === r.actionId);
            if (!match) {
              throw new Error(
                `action "${r.actionId}" is not offered by ${r.itemId} (offered: ${actions.map((a) => a.id).join(', ') || 'none'})`,
              );
            }
            if (!match.terminal && r.outcome === 'auto_resolved') {
              throw new Error(
                `action "${r.actionId}" only opens a sub-surface — it resolves nothing, so it cannot be an auto_resolved outcome`,
              );
            }
          }
        }

        accepted.push({
          itemId: r.itemId,
          outcome: r.outcome,
          actionId: r.actionId ?? null,
          rationale: clampText(r.rationale, LIMITS.ANNOTATION)?.trim() ?? null,
          draftAnswer: clampText(r.draftAnswer, LIMITS.ANNOTATION)?.trim() ?? null,
          confidence: r.confidence ?? null,
          consulted: r.consulted === true,
          consultReply: clampText(r.consultReply, LIMITS.ANNOTATION)?.trim() ?? null,
          error: clampText(r.error, LIMITS.ANNOTATION)?.trim() ?? null,
        });
        return { ok: true as const, itemId: r.itemId, outcome: r.outcome };
      },
      { keyOf: ({ itemId }) => ({ itemId }) },
    );

    let unknown: string[] = [];
    if (accepted.length > 0) {
      const res = await reportOutcomes({ runId, outcomes: accepted });
      unknown = res.unknown;

      // WI-41013 — the run was stopped (or settled) between your last read and
      // this report, so NOTHING was written. Return immediately and loudly:
      // skipping the triage overlay below matters, because writing an audit row
      // for an outcome the run never recorded would leave the two stores
      // disagreeing about what happened. If you had already taken the action,
      // say so to the owner rather than retrying it outside the run.
      if (res.refused) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                refused: res.refused.reason,
                phase: res.refused.phase,
                runId,
                wrote: 0,
                message:
                  'This run is no longer accepting reports — the owner stopped it, or it has already settled. STOP: take no further action on any item in this run. Nothing from this report was written.',
              }),
            },
          ],
        };
      }

      // Requirement 4: an action taken on the owner's behalf leaves an audit row
      // in the SAME store the manual path writes to, so `plans.attention` shows
      // it as auditable "Handled by operator" rather than a silent vanish.
      for (const a of accepted) {
        if (a.outcome !== 'auto_resolved') continue;
        try {
          await upsertTriage({
            itemId: a.itemId,
            action: 'resolve',
            note: `Bulk resolve: ${a.rationale ?? 'resolved by the bulk-resolve agent'}`,
            triagedBy: identity.ownerId,
          });
        } catch {
          // Best-effort overlay — the outcome row above is the durable record.
        }
      }

      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        await notifySyncInvalidate('plans.attentionBulkRun');
        await notifySyncInvalidate('plans.attention');
      } catch {
        /* the poll fallback still picks it up */
      }
    }

    if (unknown.length === 0) return bulkContent(env);
    // Unknown ids are surfaced BESIDE the bulk envelope rather than as failures:
    // each reported item that existed still landed, and the resolver needs to
    // know which ids it invented or carried over from a different run.
    return bulkContent({
      ...(env as unknown as Record<string, unknown>),
      ignored: {
        reason: "not in this run's snapshot",
        itemIds: unknown,
        why: 'A run acts on exactly the items the owner was looking at; widening it silently would break that guarantee.',
      },
    });
  },
});

// WI-41021 — DELIBERATELY NOT FLAG-GATED. Do not "fix" this by adding a
// bulkResolveEnabled() check to match its two siblings: settle is the WIND-DOWN
// path, the tool half of the owner's Stop. Refusing it while the flag is off
// would strand every in-flight run in `running` forever — the same inversion the
// route-level blanket gate had (a kill switch that disables the kill button),
// one level down. The flag gates ACTING (manifest authority, report writes);
// finishing cleanly is never gated.
export const bulkRunSettle = defineTool({
  name: 'inbox:bulk-run-settle',
  description:
    'End your BULK RESOLVE pass. The final phase is DERIVED from the item rows, not from what you claim: `review` when anything is still recommended or was never reached, `complete` only when nothing is left for the owner. Pass `failed:true` with a reason when you are giving up part-way — the partial outcomes are kept and the untouched items stay resolvable by hand, which is strictly better than leaving the run stuck on "running" forever.',
  guidance: {
    when: 'Once every item in the manifest has been reported — the last call of a bulk-resolve pass, before you end your turn.',
    notWhen: 'Mid-pass (keep reporting via inbox:bulk-run-report).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional().describe('the run; omit for the active one'),
    failed: z.boolean().optional().describe('true when abandoning the run part-way'),
    error: softText(LIMITS.ANNOTATION).optional().describe('why you are abandoning it (required with failed:true)'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'no_active_run' }) }],
      };
    }

    const run = args.failed
      ? await setRunPhase({
          runId,
          phase: 'failed',
          resolverOwner: identity.ownerId,
          error: clampText(args.error, LIMITS.ANNOTATION)?.trim() || 'resolver abandoned the run',
        })
      : await settleRunPhase({ runId, resolverOwner: identity.ownerId });

    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.attentionBulkRun');
    } catch {
      /* poll fallback */
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            runId,
            phase: run?.phase ?? null,
            autoResolved: run?.autoResolved ?? 0,
            recommended: run?.recommended ?? 0,
            skipped: run?.skipped ?? 0,
            failed: run?.failed ?? 0,
          }),
        },
      ],
    };
  },
});

export default bulkRunManifest;
