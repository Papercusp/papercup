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
import { listEscalations } from '../../../agent-tools/coordination/escalations';
import { listHandoffs } from '../../../agent-tools/coordination/handoffs';
import { coordLog } from '../../../agent-tools/coordination/log';
import { type CoordEnvelope } from '../../../agent-tools/coordination/envelope';

/**
 * Read every message envelope from the coord event log, no filtering.
 * Routes through `coordLog` (the PG-backed CoordEventLog) rather than the
 * old direct `coord/messages/*.jsonl` read — coord-channels-pg-port P-009.
 */
async function readAllMessages(): Promise<CoordEnvelope[]> {
  return coordLog.readLines('messages');
}

interface HistoryItem {
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

const history = defineTool({
  method: 'GET',
  path: '/coord/history',
  auth: 'public',
  async handler(req) {
    const q = new URL(req.url).searchParams;
    const kindsParam = q.get('kinds');
    const wanted = kindsParam
      ? new Set(kindsParam.split(',').map((s) => s.trim()))
      : null;
    const planSlug = q.get('plan_slug');
    const owner = q.get('owner');
    const sinceTs = q.get('since_ts');
    const sinceMs = sinceTs ? new Date(sinceTs).getTime() : 0;
    const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '200', 10) || 200, 1), 1000);

    const items: HistoryItem[] = [];
    if (!wanted || wanted.has('plan_event')) {
      const events = await readPlanEvents({});
      for (const e of events) items.push(toHistoryItem('plan_event', e));
    }
    if (!wanted || wanted.has('message')) {
      const msgs = await readAllMessages();
      for (const m of msgs) items.push(toHistoryItem('message', m));
    }
    if (!wanted || wanted.has('escalation')) {
      const escs = await listEscalations({});
      for (const e of escs) items.push(toHistoryItem('escalation', e));
    }
    if (!wanted || wanted.has('handoff')) {
      const hs = await listHandoffs({});
      for (const h of hs) {
        items.push(toHistoryItem('handoff', h.record));
        if (h.accepted_by) items.push(toHistoryItem('handoff', h.accepted_by));
      }
    }

    let filtered = items;
    if (planSlug) filtered = filtered.filter((it) => it.plan_slug === planSlug);
    if (owner) {
      filtered = filtered.filter(
        (it) => it.from === owner || (it.to ?? []).includes(owner) || (it.to ?? []).includes('*'),
      );
    }
    if (sinceMs > 0) filtered = filtered.filter((it) => new Date(it.ts).getTime() > sinceMs);

    filtered.sort((a, b) => b.ts.localeCompare(a.ts) || b.msg_id.localeCompare(a.msg_id));
    const truncated = filtered.length > limit;
    const out = truncated ? filtered.slice(0, limit) : filtered;
    return Response.json({ items: out, total: filtered.length, truncated });
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
    // Strictly the human-facing inbox: entries with 'human' in `to`.
    const msgs = await readAllMessages();
    const escs = await listEscalations({});
    const hs = await listHandoffs({});
    const items: HistoryItem[] = [];
    for (const m of msgs) {
      if (Array.isArray(m.to) && m.to.includes('human')) items.push(toHistoryItem('message', m));
    }
    for (const e of escs) {
      if (e.resolved == null) items.push(toHistoryItem('escalation', e));
    }
    for (const h of hs) {
      if (Array.isArray(h.record.to) && h.record.to.includes('human')) {
        items.push(toHistoryItem('handoff', h.record));
      }
    }
    items.sort((a, b) => b.ts.localeCompare(a.ts) || b.msg_id.localeCompare(a.msg_id));
    return Response.json({ items });
  },
});

const plans = defineTool({
  method: 'GET',
  path: '/coord/plans',
  auth: 'public',
  async handler() {
    const { readAllPlans } = await import('../../../agent-tools/plans/source');
    const all = await readAllPlans({});
    const out = all
      .filter((p) => !p.parsed.isLegacy)
      .map((p) => ({
        slug: p.parsed.frontmatter.slug ?? p.parsed.slug,
        title: p.parsed.frontmatter.title ?? p.parsed.slug,
        status: p.parsed.frontmatter.status ?? 'unknown',
        updated: p.parsed.frontmatter.updated ?? null,
        now_state: p.parsed.now?.state ?? null,
        now_next: p.parsed.now?.next ?? null,
        item_count: p.parsed.items.length,
        decision_count: p.parsed.decisions.length,
      }));
    return Response.json({ plans: out });
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
