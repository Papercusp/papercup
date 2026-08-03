/**
 * /api/coord/* — read-only history routes for the agent-coordination
 * substrate. Phase E13 (endpoint-unification-2026-05-21): ported off the
 * legacy `_hono/coord.ts` Hono sub-app onto `defineTool`. URLs unchanged.
 *
 * All routes are `auth: 'public'` — the legacy `coord` sub-app carried
 * no auth middleware; the `/coord` UI fetches these unauthenticated and
 * they are loopback-protected by the host bind. Posture preserved
 * verbatim (the route-migration rule: a mechanical port does not
 * tighten auth).
 *
 *   GET /api/coord/history      merged feed (plan-events/messages/escalations/handoffs)
 *   GET /api/coord/presence     active + stale presence records
 *   GET /api/coord/inbox        human-facing inbox
 *   GET /api/coord/plans        plan directory
 *   GET /api/coord/plans/:slug  one plan + raw markdown
 *   GET /api/coord/escalations  list-only
 *   GET /api/coord/handoffs     list-only
 *   GET /api/coord/plan-events  list-only
 */
import { defineTool } from '@papercusp/agent-mcp';
import inboxSse from './inbox-sse';
import { readPlanEvents } from '../../../agent-tools/coordination/plan-events';
import { listEscalations, listEscalationsPaginated } from '../../../agent-tools/coordination/escalations';
import { listHandoffs, listHandoffsPaginated } from '../../../agent-tools/coordination/handoffs';
import { coordLog } from '../../../agent-tools/coordination/log';
import { type CoordEnvelope } from '../../../agent-tools/coordination/envelope';

export interface HistoryItem {
  ts: string;
  msg_id: string;
  source: 'plan_event' | 'message' | 'escalation' | 'handoff';
  kind: string;
  from?: string;
  to?: string[];
  plan_slug?: string;
  harness_slug?: string;
  summary?: string;
  payload: CoordEnvelope;
}

function envSummary(e: CoordEnvelope): string {
  const detail = (e as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail.slice(0, 200);
  const event = (e as { event?: unknown }).event;
  if (typeof event === 'string') return event;
  return e.kind;
}

function toHistoryItem(source: HistoryItem['source'], e: CoordEnvelope): HistoryItem {
  const plan_slug = typeof (e as { plan_slug?: unknown }).plan_slug === 'string'
    ? ((e as { plan_slug?: string }).plan_slug as string)
    : undefined;
  const harness_slug = typeof (e as { harness_slug?: unknown }).harness_slug === 'string'
    ? ((e as { harness_slug?: string }).harness_slug as string)
    : undefined;
  return {
    ts: e.ts,
    msg_id: e.msg_id,
    source,
    kind: e.kind,
    from: e.from,
    to: e.to,
    plan_slug,
    harness_slug,
    summary: envSummary(e),
    payload: e,
  };
}

// EI-18138089781782660: this used to read the WHOLE coord corpus (every
// plan-event + every message + every escalation + every handoff, unbounded)
// on every call, then filter/sort/slice in JS — cost grew unboundedly with
// total coord volume. Every per-surface fetch below is now a BOUNDED storage
// read: readPlanEvents already pushes since_ts/planSlug into its own bounded
// query; messages go through `readLinesBounded` (limit/sinceTs/planSlug
// pushed to SQL, same primitive plan-events uses); escalations/handoffs go
// through their already-bounded/folded `*Paginated` readers (which page a
// coverage window deeper rather than risk a zombie "open" record — the same
// pattern WI-4181 hardened for escalations, now mirrored for handoffs). The
// `owner` filter still runs in JS over the bounded window (matching
// `readCoordFeed`'s established convention — see feed.ts's WI-3869 comment;
// pushing an owner/`to`-array-containment filter into SQL isn't the part
// that was unbounded).
//
// PUSHDOWN_CAP mirrors feed.ts's RAW_SURFACE_FETCH_CAP: fetch at most this
// many rows per surface regardless of the final page `limit`, so a caller
// asking for a small page with a narrow (planSlug/owner) filter still gets a
// wide-enough window to find its matches, without ever re-materializing the
// whole surface.
const PUSHDOWN_CAP = 1000;

export async function loadCoordHistory(args: {
  kinds?: string[];
  planSlug?: string;
  owner?: string;
  sinceTs?: string;
  limit?: number;
} = {}): Promise<{ items: HistoryItem[]; total: number; truncated: boolean }> {
  const wanted = args.kinds?.length ? new Set(args.kinds) : null;
  const sinceMs = args.sinceTs ? new Date(args.sinceTs).getTime() : 0;
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
  const pushdownLimit = Math.min(Math.max(limit * 3, 200), PUSHDOWN_CAP);
  const items: HistoryItem[] = [];
  if (!wanted || wanted.has('plan_event')) {
    for (const e of await readPlanEvents({
      planSlugs: args.planSlug ? [args.planSlug] : undefined,
      since_ts: args.sinceTs,
      limit: pushdownLimit,
    })) items.push(toHistoryItem('plan_event', e));
  }
  if (!wanted || wanted.has('message')) {
    const bounded = await coordLog.readLinesBounded('messages', {
      limit: pushdownLimit,
      ...(args.sinceTs ? { sinceTs: args.sinceTs } : {}),
      ...(args.planSlug ? { planSlug: args.planSlug } : {}),
    });
    for (const e of bounded) items.push(toHistoryItem('message', e));
  }
  if (!wanted || wanted.has('escalation')) {
    const { escalations } = await listEscalationsPaginated({ maxRecords: pushdownLimit });
    for (const e of escalations) items.push(toHistoryItem('escalation', e));
  }
  if (!wanted || wanted.has('handoff')) {
    const { handoffs } = await listHandoffsPaginated({ maxRecords: pushdownLimit });
    for (const h of handoffs) {
      items.push(toHistoryItem('handoff', h.record));
      if (h.accepted_by) items.push(toHistoryItem('handoff', h.accepted_by));
    }
  }
  let filtered = items;
  if (args.planSlug) filtered = filtered.filter((it) => it.plan_slug === args.planSlug);
  if (args.owner) {
    const owner = args.owner;
    filtered = filtered.filter(
      (it) => it.from === owner || (it.to ?? []).includes(owner) || (it.to ?? []).includes('*'),
    );
  }
  if (sinceMs > 0) filtered = filtered.filter((it) => new Date(it.ts).getTime() > sinceMs);
  filtered.sort((a, b) => b.ts.localeCompare(a.ts) || b.msg_id.localeCompare(a.msg_id));
  const truncated = filtered.length > limit;
  return { items: truncated ? filtered.slice(0, limit) : filtered, total: filtered.length, truncated };
}

// EI-18138089781782660: same anti-pattern as loadCoordHistory before it was
// fixed — this used to read the WHOLE coord corpus (readAllMessages() with no
// LIMIT, listEscalations({})/listHandoffs({}) with no status filter, each an
// unbounded full-surface event replay) on every call, then filter down to the
// human-directed subset in JS. Cost grew unboundedly with total coord volume
// even though the human-facing inbox is typically tiny. Now every per-surface
// fetch is the same BOUNDED storage read loadCoordHistory uses: messages go
// through `readLinesBounded` (limit pushed to SQL); escalations go through
// `listEscalationsPaginated({ status: 'open' })`, which folds status server
// side (no `resolved == null` JS filter needed) AND already pages deep enough
// to avoid the WI-4181 zombie-open class; handoffs go through
// `listHandoffsPaginated` (same bounded/folded primitive as loadCoordHistory).
export async function loadCoordInbox(): Promise<HistoryItem[]> {
  const [msgs, { escalations }, { handoffs }] = await Promise.all([
    coordLog.readLinesBounded('messages', { limit: PUSHDOWN_CAP }),
    // listEscalationsPaginated/listHandoffsPaginated clamp maxRecords to 500
    // internally regardless — pass 500 explicitly rather than PUSHDOWN_CAP
    // (1000) to avoid implying a wider window than these primitives honor.
    listEscalationsPaginated({ status: 'open', maxRecords: 500 }),
    listHandoffsPaginated({ maxRecords: 500 }),
  ]);
  const items: HistoryItem[] = [];
  for (const m of msgs) {
    if (Array.isArray(m.to) && m.to.includes('human')) items.push(toHistoryItem('message', m));
  }
  for (const e of escalations) {
    items.push(toHistoryItem('escalation', e));
  }
  for (const h of handoffs) {
    if (Array.isArray(h.record.to) && h.record.to.includes('human')) items.push(toHistoryItem('handoff', h.record));
  }
  return items.sort((a, b) => b.ts.localeCompare(a.ts) || b.msg_id.localeCompare(a.msg_id));
}

export async function loadCoordPlans(): Promise<Array<Record<string, unknown>>> {
  const { readAllPlans } = await import('../../../agent-tools/plans/source');
  return (await readAllPlans({}))
    .filter((p) => !p.parsed.isLegacy)
    .map((p) => ({
      // IDENTITY AND LIFECYCLE COME FROM THE ROW, NEVER THE MARKDOWN (WI-7246).
      // A scheduled-run snapshot (`<slug>@run-<epochms>`) copies its parent
      // plan's body verbatim — frontmatter included — so the self-declared
      // `slug`/`status` of all 50 papercusp snapshots read as the PARENT's.
      // Trusting them collapsed 51 distinct plans into ONE identity: 51
      // duplicate React keys, every row fetching the parent's markdown, one
      // click expanding all 51 at once, and `superseded` rows rendering as
      // `draft`. `plan_slug` is also the only value that round-trips —
      // /coord/plans/:slug resolves via readPlanBySlug -> getPlanRow.
      slug: p.row.planSlug,
      title: p.parsed.frontmatter.title ?? p.row.planSlug,
      status: p.row.status ?? p.parsed.frontmatter.status ?? 'unknown',
      // Canonical-first for consistency with slug/status, though measured as a
      // NO-OP today: the `updated` column is NULL on all 50 snapshots, so this
      // falls through to the frontmatter exactly as before. (`title`
      // deliberately still LEADS with the frontmatter — it is display text
      // rather than identity, and its 20 row-vs-markdown divergences have a
      // separate, undiagnosed cause.)
      updated: p.row.updated ?? p.parsed.frontmatter.updated ?? null,
      now_state: p.parsed.now?.state ?? null,
      now_next: p.parsed.now?.next ?? null,
      item_count: p.parsed.items.length,
      decision_count: p.parsed.decisions.length,
    }));
}

const history = defineTool({
  method: 'GET',
  path: '/coord/history',
  auth: 'public',
  async handler(req) {
    const q = new URL(req.url).searchParams;
    return Response.json(await loadCoordHistory({
      kinds: q.get('kinds')?.split(',').map((s) => s.trim()).filter(Boolean),
      planSlug: q.get('plan_slug') ?? undefined,
      owner: q.get('owner') ?? undefined,
      sinceTs: q.get('since_ts') ?? undefined,
      limit: parseInt(q.get('limit') ?? '200', 10) || 200,
    }));
  },
});

const presence = defineTool({
  method: 'GET',
  path: '/coord/presence',
  auth: 'public',
  async handler(req) {
    const { listPresence } = await import('../../../agent-tools/coordination/presence');
    const ws = new URL(req.url).searchParams.get('workspace');
    const records = await listPresence({ workspaceId: ws });
    return Response.json({
      active: records.filter((r) => !r.stale),
      stale: records.filter((r) => r.stale),
    });
  },
});

const inbox = defineTool({
  method: 'GET',
  path: '/coord/inbox',
  auth: 'public',
  async handler() {
    return Response.json({ items: await loadCoordInbox() });
  },
});

const plans = defineTool({
  method: 'GET',
  path: '/coord/plans',
  auth: 'public',
  async handler() {
    return Response.json({ plans: await loadCoordPlans() });
  },
});

const planBySlug = defineTool({
  method: 'GET',
  path: '/coord/plans/:slug',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug;
    const { readPlanBySlug } = await import('../../../agent-tools/plans/source');
    const { readFile } = await import('node:fs/promises');
    const found = await readPlanBySlug(slug);
    if (!found) return Response.json({ error: 'plan not found' }, { status: 404 });
    let markdown = '';
    try {
      markdown = await readFile(found.parsed.filePath, 'utf8');
    } catch {
      return Response.json({ error: 'plan file unreadable' }, { status: 500 });
    }
    return Response.json({
      slug,
      title: found.parsed.frontmatter.title ?? slug,
      status: found.parsed.frontmatter.status ?? 'unknown',
      archived: found.archived,
      markdown,
    });
  },
});

const escalations = defineTool({
  method: 'GET',
  path: '/coord/escalations',
  auth: 'public',
  async handler(req) {
    const status = new URL(req.url).searchParams.get('status');
    const opts: { status?: 'open' | 'resolved' } = {};
    if (status === 'open' || status === 'resolved') opts.status = status;
    return Response.json({ items: await listEscalations(opts) });
  },
});

const handoffs = defineTool({
  method: 'GET',
  path: '/coord/handoffs',
  auth: 'public',
  async handler(req) {
    const status = new URL(req.url).searchParams.get('status');
    const opts: { status?: 'open' | 'accepted' } = {};
    if (status === 'open' || status === 'accepted') opts.status = status;
    return Response.json({ items: await listHandoffs(opts) });
  },
});

const planEvents = defineTool({
  method: 'GET',
  path: '/coord/plan-events',
  auth: 'public',
  async handler(req) {
    const q = new URL(req.url).searchParams;
    const planSlug = q.get('plan_slug');
    const eventsParam = q.get('events');
    const sinceTs = q.get('since_ts');
    const opts: { planSlugs?: string[]; events?: never[]; since_ts?: string } = {};
    if (planSlug) opts.planSlugs = [planSlug];
    if (eventsParam) {
      (opts as { events?: string[] }).events = eventsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (sinceTs) opts.since_ts = sinceTs;
    return Response.json({ items: await readPlanEvents(opts as never) });
  },
});

export default [
  history,
  presence,
  inbox,
  inboxSse,
  plans,
  planBySlug,
  escalations,
  handoffs,
  planEvents,
];
