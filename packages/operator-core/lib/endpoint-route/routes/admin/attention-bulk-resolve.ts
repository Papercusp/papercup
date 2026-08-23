/**
 * POST /api/admin/attention-bulk-resolve — start a BULK RESOLVE run over the
 * items the Inbox pane is currently showing (inbox-bulk-resolve-2026-08-23,
 * P-002).
 *
 * Same admin-tier posture as coord-inbox-reply: the desktop webview hits the
 * operator loopback with no cookie/bearer, so `unverified-loopback` stays
 * admitted, with the CORS/CSRF backstop refusing a browser cross-origin POST.
 *
 * WHY THE CLIENT POSTS ITEM IDS RATHER THAN ITS FILTERS. `plans.attention` is a
 * live, SSE-invalidated feed. Re-deriving the owner's filtered set server-side
 * would resolve against a set that has moved since they looked, so the run could
 * silently act on an item they never saw — the one thing a bulk action must
 * never do. The client therefore posts the concrete id list it is rendering, and
 * `filter` rides along as human-readable provenance for the record only.
 *
 * Body: { items:[{ itemId, kind?, title?, ref?, ownerAgentId? }], filter?, harness? }
 *     → { ok, runId, phase, totalItems, launched, launchError? }
 *
 * A LAUNCH FAILURE IS NOT A REQUEST FAILURE. The run row is created first and
 * returned even when the resolver could not be launched: the owner then sees a
 * failed run naming the reason, with every item untouched and still resolvable
 * by hand, instead of a click that silently did nothing.
 *
 * THE OWNER-SIDE OPS ride the same route under an `op` discriminator (P-006),
 * because they share this route's admin-tier posture, its CSRF backstop and its
 * one sync invalidation — a separate route per verb would duplicate all three:
 *   { op:'stop',    runId }                     → settle the run where it stands
 *   { op:'accept',  runId, itemId, actionId }   → record an accepted recommendation
 *   { op:'dismiss', runId }                     → close the run without acting
 *
 * `accept` RECORDS ONLY. The resolution itself is dispatched CLIENT-side through
 * the same `resolveAttentionAction` / `replyToAttentionItem` helpers a hand
 * resolve uses, so asker-wake, provenance and the triage audit note are produced
 * by exactly one code path (D-003). Re-deriving the resolve here would fork that
 * behavior into a second implementation that drifts silently.
 */

import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { requireAllowedOriginOr403 } from '../../cors';
import { gateApiRoute } from '../../../require-flag';
import {
  BulkRunAlreadyActiveError,
  createRun,
  markItemAccepted,
  setRunPhase,
  settleRunPhase,
  type BulkRunSeedItem,
} from '../../../attention/bulk-run-store';

/** Cap one run so a mis-click on an unfiltered inbox cannot enqueue thousands. */
const MAX_RUN_ITEMS = 200;

function parseItems(raw: unknown): BulkRunSeedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: BulkRunSeedItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const itemId = typeof o.itemId === 'string' ? o.itemId.trim() : '';
    if (!itemId) continue;
    out.push({
      itemId,
      kind: typeof o.kind === 'string' ? o.kind : null,
      title: typeof o.title === 'string' ? o.title.slice(0, 1000) : null,
      ref: o.ref && typeof o.ref === 'object' ? (o.ref as Record<string, unknown>) : {},
      ownerAgentId: typeof o.ownerAgentId === 'string' ? o.ownerAgentId : null,
    });
    if (out.length >= MAX_RUN_ITEMS) break;
  }
  return out;
}

/**
 * The resolver's brief. Written here rather than in a prompt file because it has
 * to name THIS run id, and because its policy half is the plan's D-001/D-002
 * decisions restated where the launch can actually enforce them.
 */
export function buildResolverBrief(runId: string, itemCount: number): string {
  return [
    `You are the BULK RESOLVE resolver for run ${runId}. The owner is clearing their Inbox and has`,
    `asked you to settle ${itemCount} attention item(s) they filtered down to.`,
    '',
    'LOOP:',
    `1. inbox:bulk-run-manifest { runId: "${runId}" } — read the run and every item, each with the`,
    '   LIVE options it actually offers. An option with terminal:false only opens a sub-surface and',
    '   resolves nothing; never treat one as a resolution.',
    '2. For each item, decide:',
    '   - AUTO-RESOLVE when you can settle it from evidence: the ask is moot (its blocker already',
    '     cleared, the work already landed), it duplicates another item, it is a stale FYI, or it is a',
    '     plain acknowledgement. You have full authority to take the terminal action, INCLUDING',
    "     delivering a derivable answer to the asking agent (which wakes them). Record WHY — that",
    '     rationale is the audit note for something done on the owner\'s behalf.',
    '   - CONSULT when you cannot settle it alone AND the item names an asking agent that is live or',
    '     parked (check coord:presence). Send them a directed coord:send asking them to either resolve',
    '     or withdraw their own ask right now, or reply with their recommended option id and a one-line',
    '     why. Give them a bounded window (~10 min). A reply that arrives lets you report the item',
    '     auto_resolved or recommended with confidence:"high"; a lapse means you recommend anyway with',
    '     confidence:"low" so the owner sees it is an inference, not evidence.',
    '   - RECOMMEND otherwise: pre-select the option id you would pick, with a rationale of at most two',
    '     sentences, plus a drafted reply where the path takes free text so the owner edits rather than',
    '     composes.',
    '   - SKIP when the item offers no options yet or you genuinely cannot judge it — with the reason.',
    `3. AUTO-RESOLVE only through inbox:bulk-run-act { runId: "${runId}", itemId, actionId,`,
    '   rationale, ... }. It is intentionally one action per call: the tool holds the run\'s revocable',
    '   authority lock across the real terminal dispatch, required audit row, outcome and counters.',
    '   Report only recommended/skipped/failed items through inbox:bulk-run-report { items:[...] }',
    '   (batch those non-action outcomes; do not call report once per item).',
    `4. inbox:bulk-run-settle { runId: "${runId}" } when every item is reported.`,
    '',
    'RULES:',
    '- NEVER invent an option id. Only ids the manifest listed for that item are accepted.',
    '- A rationale is REQUIRED on every bulk-run-act; a reason is REQUIRED on skipped/failed reports.',
    '- inbox:bulk-run-report rejects auto_resolved. Never dispatch an item\'s backing verb directly;',
    '  only bulk-run-act can prove Stop had not revoked your authority before the action began.',
    '- Prefer recommending over resolving when the item turns on the owner\'s preference, money, an',
    '  irreversible action, or anything only they can know. Speed is not worth a wrong resolution.',
    '- Look for cross-item structure: several escalations with one root cause should be resolved',
    '  consistently, not judged independently.',
    '- If you must give up, inbox:bulk-run-settle { failed: true, error } so the owner sees why.',
    '',
    'STOPPING (WI-41022) — Stop is authoritative at the bulk-run-act boundary:',
    '- The manifest carries `stopped`. Re-read the manifest before each BATCH of terminal actions,',
    '  and the moment `stopped` is true, HALT: take no further terminal action on any item, do not',
    '  report, and do not re-route the work to an item\'s own verb outside the run. Stopping is the',
    '  owner withdrawing your authority, not a hint to finish faster.',
    '- bulk-run-act and Stop take the SAME run-row lock. If Stop commits first, bulk-run-act refuses',
    '  BEFORE entering the terminal callback. If an action commits first, Stop waits for its required',
    '  audit + outcome + counters, then settles with that action visible. There is no cooperative',
    '  check-then-act gap. A post_dispatch_persistence_failed response is a loud partial incident:',
    '  do NOT retry the terminal action; report its reconciliationRequired payload immediately.',
    '- inbox:bulk-run-report can still refuse non-action reports after Stop; nothing in that report',
    '  was recorded, and you must halt rather than route around the run.',
  ].join('\n');
}

/**
 * Launch the resolver. Best-effort by design: every failure path returns a
 * reason rather than throwing, so the caller can record it on the run.
 */
async function launchResolver(
  runId: string,
  itemCount: number,
  harness: string | null,
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const [{ buildConsoleEnvelope }, { spawnHeadless }, { activeWorkspaceId }, { resolveSpawnHostOperatorBaseUrl }] =
      await Promise.all([
        import('../../../console-launcher'),
        import('../../../console-spawn'),
        import('../../../workspace-registry'),
        import('../../../mcp-base-url'),
      ]);

    const envelope = await buildConsoleEnvelope({
      workspaceId: activeWorkspaceId(),
      slug: harness,
      operatorBaseUrl: await resolveSpawnHostOperatorBaseUrl(),
      headless: true,
      role: 'su',
    } as Parameters<typeof buildConsoleEnvelope>[0]);

    // The brief rides PAPERCUSP_KICKOFF_PROMPT (never a `--kickoff=` value):
    // free-form prose inside a console one-liner is a quoting hazard, and the
    // env var is the spawn-safe path capability:launch-agent itself uses.
    const res = await spawnHeadless({
      envelope: {
        ...envelope,
        env: { ...envelope.env, PAPERCUSP_KICKOFF_PROMPT: buildResolverBrief(runId, itemCount) },
      },
      label: `bulk-resolve-${runId.slice(0, 12)}`,
    });

    const sessionId = (res as { sessionId?: string })?.sessionId;
    return { ok: true, sessionId: typeof sessionId === 'string' ? sessionId : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Push the new run/item state to every mounted strip. Best-effort: the poll
 *  fallback still picks it up, so a notify failure must never fail the op. */
async function invalidateBulkRun(): Promise<void> {
  try {
    const { notifySyncInvalidate } = await import('../../../sync-sse');
    await notifySyncInvalidate('plans.attentionBulkRun');
  } catch {
    /* the poll fallback still picks it up */
  }
}

/**
 * The three owner-side ops. Each returns the run's resulting phase so the strip
 * can render from the response without waiting for the SSE round-trip.
 */
async function handleOwnerOp(op: string, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!runId) {
    return Response.json(
      { error: { code: 'missing_run_id', message: `op "${op}" requires runId` } },
      { status: 400 },
    );
  }

  try {
    if (op === 'stop') {
      // Settle where it stands rather than forcing `complete`: settleRunPhase
      // derives the phase from the ITEM ROWS, so a stop mid-run parks in
      // `review` with whatever the resolver got through — including the items
      // it never reached, which stay `pending` and are shown as not-reached
      // rather than silently dropped (Requirement 2).
      const run = await settleRunPhase({ runId });
      await invalidateBulkRun();
      return Response.json({ ok: true, runId, phase: run?.phase ?? null, stopped: true });
    }

    if (op === 'dismiss') {
      // The owner is done with the review list. The run closes; the items it
      // recommended stay recommended in the record (nothing is retro-resolved),
      // and every one of them is still resolvable by hand in the pane.
      const run = await setRunPhase({ runId, phase: 'complete' });
      await invalidateBulkRun();
      return Response.json({ ok: true, runId, phase: run?.phase ?? null, dismissed: true });
    }

    if (op === 'accept') {
      const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
      const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : '';
      if (!itemId || !actionId) {
        return Response.json(
          {
            error: {
              code: 'missing_accept_fields',
              message: 'op "accept" requires itemId and actionId',
            },
          },
          { status: 400 },
        );
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
      const item = await markItemAccepted({ runId, itemId, actionId, note });
      if (!item) {
        return Response.json(
          {
            error: {
              code: 'item_not_in_run',
              message: `item ${itemId} is not part of run ${runId}`,
            },
          },
          { status: 404 },
        );
      }
      // An accept can be the LAST one — re-settle so the strip leaves `review`
      // on its own instead of stranding the owner on an empty review list.
      const run = await settleRunPhase({ runId });
      await invalidateBulkRun();
      return Response.json({ ok: true, runId, itemId, phase: run?.phase ?? null, accepted: true });
    }

    return Response.json(
      {
        error: {
          code: 'unknown_op',
          message: `op must be one of start | stop | accept | dismiss (got "${op}")`,
        },
      },
      { status: 400 },
    );
  } catch (e) {
    return Response.json(
      {
        error: {
          code: 'bulk_resolve_op_failed',
          message: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 500 },
    );
  }
}

async function handler(req: Request, _ctx: RouteContext): Promise<Response> {
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { code: 'invalid_json', message: 'request body must be JSON' } },
      { status: 400 },
    );
  }

  const op = typeof body.op === 'string' ? body.op : 'start';

  // WI-41021 — THE FLAG GATES ACTING, NEVER STOPPING.
  //
  // The flag still has to cut the WRITE SEAM and not just the strip: InboxPane
  // gates the UI with useFlag, but a client-only gate leaves this route reachable
  // while the feature is "off", and `op:'start'` LAUNCHES A REAL HEADLESS RESOLVER
  // AGENT that then acts on the owner's inbox. A kill switch that still spawns
  // agents is not a kill switch.
  //
  // But the previous version gated the WHOLE handler, above this point, and that
  // was backwards. Every owner op routes through here, so a blanket gate ALSO 404'd
  // `op:'stop'` — flipping the kill switch took away the owner's kill button. And
  // it bought nothing, because the resolver does not drive a run through this route
  // at all: it uses inbox:bulk-run-* (gated separately, same rule). So the flag-off
  // state was the worst of both — the owner could not stop the run, and the agent
  // could not be stopped.
  //
  // STOP_OPS are therefore ALWAYS reachable, flag or no flag. `stop` is the kill
  // path itself; `dismiss` only closes a review list the owner is already looking
  // at, and refusing it strands them with a list they cannot clear. Everything else
  // — `start` (spawns an agent) and `accept` (takes a terminal action on the
  // owner's behalf) — is ACTING, and stays gated. Nothing is lost by gating
  // `accept`: every recommended item remains resolvable by hand in the pane.
  const STOP_OPS = new Set(['stop', 'dismiss']);
  if (!STOP_OPS.has(op)) {
    const gated = await gateApiRoute(req, FLAGS.INBOX_BULK_RESOLVE);
    if (gated) return gated;
  }

  if (op !== 'start') return handleOwnerOp(op, body);

  const items = parseItems(body.items);
  if (items.length === 0) {
    return Response.json(
      {
        error: {
          code: 'no_items',
          message: 'items[] must carry at least one { itemId } — a run over nothing is never correct',
        },
      },
      { status: 400 },
    );
  }

  const harness = typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : null;
  const filter =
    body.filter && typeof body.filter === 'object' ? (body.filter as Record<string, unknown>) : {};

  try {
    const run = await createRun({
      items,
      filterSnapshot: filter,
      requestedBy: 'owner',
      harnessSlug: harness,
    });

    const launched = await launchResolver(run.runId, items.length, harness);
    if (launched.ok) {
      await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: launched.sessionId ?? null });
    } else {
      // Requirement 8: a failed launch is visible as a failed run with its items
      // intact — never a click that silently did nothing.
      await setRunPhase({ runId: run.runId, phase: 'failed', error: launched.error ?? 'launch failed' });
    }

    await invalidateBulkRun();

    return Response.json({
      ok: true,
      runId: run.runId,
      phase: launched.ok ? 'running' : 'failed',
      totalItems: run.totalItems,
      launched: launched.ok,
      ...(launched.ok ? {} : { launchError: launched.error }),
    });
  } catch (e) {
    // WI-41012 — a run is already pending/running. This is the ONE start-path
    // failure that is not an error in the caller: the owner (or a double-click)
    // asked for a second run while an agent is mid-flight over overlapping
    // items. Answer 409 naming the run already in flight so the strip can point
    // at it, rather than a 500 that reads like the feature broke.
    if (e instanceof BulkRunAlreadyActiveError) {
      return Response.json(
        {
          error: {
            code: e.code,
            message: e.message,
            runId: e.activeRunId,
            phase: e.activePhase,
          },
        },
        { status: 409 },
      );
    }
    return Response.json(
      {
        error: {
          code: 'bulk_resolve_start_failed',
          message: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 500 },
    );
  }
}

const route = defineTool({
  method: 'POST',
  path: '/admin/attention-bulk-resolve',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler,
});

export default [route];
