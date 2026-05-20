/**
 * /api/coord/* — read-only history routes for the agent-coordination
 * substrate (agent-coordination-architecture-v2).
 *
 * The MCP tools (`coord:*`) are the canonical write surface and
 * already exist; this file adds the **read** surface for the `/coord`
 * UI history viewer (Phase B remainder).
 *
 * Routes:
 *
 *   GET /api/coord/history — merged history feed across plan-events,
 *     messages, escalations, handoffs. Filter via query params:
 *       ?kinds=plan_event,message,escalation,handoff (comma-separated)
 *       ?plan_slug=<slug>             — restrict to one plan
 *       ?owner=<owner_id>             — restrict messages/handoffs to
 *                                       envelopes mentioning this owner
 *       ?since_ts=<ISO>               — newer-than
 *       ?limit=<N>                    — cap (default 200, max 1000)
 *
 *     Response: { items: HistoryItem[], total: number, truncated: bool }
 *
 *   GET /api/coord/escalations?status=open|resolved — list-only
 *   GET /api/coord/handoffs?status=open|accepted — list-only
 *   GET /api/coord/plan-events?plan_slug=&events=&since_ts= — list-only
 */

import { Hono } from 'hono';
import { readPlanEvents } from '@/lib/agent-tools/coordination/plan-events';
import { listEscalations } from '@/lib/agent-tools/coordination/escalations';
import { listHandoffs } from '@/lib/agent-tools/coordination/handoffs';
import { messagesDir } from '@/lib/agent-tools/coordination/paths';
import { readCoordFile, type CoordEnvelope } from '@/lib/agent-tools/coordination/envelope';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const coord = new Hono();

/** Read every message envelope in coord/messages/*.jsonl, no filtering. */
async function readAllMessages(): Promise<CoordEnvelope[]> {
  const dir = messagesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const out: CoordEnvelope[] = [];
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const lines = await readCoordFile(join(dir, f));
    for (const l of lines) out.push(l);
  }
  return out;
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

function toHistoryItem(
  source: HistoryItem['source'],
  e: CoordEnvelope,
): HistoryItem {
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

coord.get('/history', async (c) => {
  const kindsParam = c.req.query('kinds');
  const wanted = kindsParam
    ? new Set(kindsParam.split(',').map((s) => s.trim()))
    : null;

  const planSlug = c.req.query('plan_slug') ?? null;
  const owner = c.req.query('owner') ?? null;
  const sinceTs = c.req.query('since_ts') ?? null;
  const sinceMs = sinceTs ? new Date(sinceTs).getTime() : 0;
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '200', 10) || 200, 1), 1000);

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
  if (planSlug) {
    filtered = filtered.filter((it) => it.plan_slug === planSlug);
  }
  if (owner) {
    filtered = filtered.filter(
      (it) => it.from === owner || (it.to ?? []).includes(owner) || (it.to ?? []).includes('*'),
    );
  }
  if (sinceMs > 0) {
    filtered = filtered.filter((it) => new Date(it.ts).getTime() > sinceMs);
  }

  filtered.sort(
    (a, b) => b.ts.localeCompare(a.ts) || b.msg_id.localeCompare(a.msg_id),
  );
  const truncated = filtered.length > limit;
  const out = truncated ? filtered.slice(0, limit) : filtered;

  return c.json({ items: out, total: filtered.length, truncated });
});

coord.get('/escalations', async (c) => {
  const status = c.req.query('status');
  const opts: { status?: 'open' | 'resolved' } = {};
  if (status === 'open' || status === 'resolved') opts.status = status;
  const list = await listEscalations(opts);
  return c.json({ items: list });
});

coord.get('/handoffs', async (c) => {
  const status = c.req.query('status');
  const opts: { status?: 'open' | 'accepted' } = {};
  if (status === 'open' || status === 'accepted') opts.status = status;
  const list = await listHandoffs(opts);
  return c.json({ items: list });
});

coord.get('/plan-events', async (c) => {
  const planSlug = c.req.query('plan_slug');
  const eventsParam = c.req.query('events');
  const sinceTs = c.req.query('since_ts');
  const opts: { planSlugs?: string[]; events?: never[]; since_ts?: string } = {};
  if (planSlug) opts.planSlugs = [planSlug];
  if (eventsParam) {
    // typed via plan-events.ts PlanEventType union; passed through verbatim.
    (opts as { events?: string[] }).events = eventsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (sinceTs) opts.since_ts = sinceTs;
  const list = await readPlanEvents(opts as never);
  return c.json({ items: list });
});
