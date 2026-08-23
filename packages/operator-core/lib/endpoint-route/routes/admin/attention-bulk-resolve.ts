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
 */

import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { createRun, setRunPhase, type BulkRunSeedItem } from '../../../attention/bulk-run-store';

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
    '3. inbox:bulk-run-report { items:[...] } as you go (batch them; do not call once per item).',
    `4. inbox:bulk-run-settle { runId: "${runId}" } when every item is reported.`,
    '',
    'RULES:',
    '- NEVER invent an option id. Only ids the manifest listed for that item are accepted.',
    '- A rationale is REQUIRED on every auto_resolved item; a reason is REQUIRED on skipped/failed.',
    '- Prefer recommending over resolving when the item turns on the owner\'s preference, money, an',
    '  irreversible action, or anything only they can know. Speed is not worth a wrong resolution.',
    '- Look for cross-item structure: several escalations with one root cause should be resolved',
    '  consistently, not judged independently.',
    '- If you must give up, inbox:bulk-run-settle { failed: true, error } so the owner sees why.',
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

    try {
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('plans.attentionBulkRun');
    } catch {
      /* the poll fallback still picks it up */
    }

    return Response.json({
      ok: true,
      runId: run.runId,
      phase: launched.ok ? 'running' : 'failed',
      totalItems: run.totalItems,
      launched: launched.ok,
      ...(launched.ok ? {} : { launchError: launched.error }),
    });
  } catch (e) {
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
