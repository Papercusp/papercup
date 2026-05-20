/**
 * plan-events.ts — the working-memory history feed.
 *
 * agent-coordination-architecture-v2 §8. Every successful plans:*
 * write verb emits one line here, after its lock-protected write
 * succeeds. Single writer (the operator process), so no contention —
 * `fs.appendFile` is sufficient.
 *
 * Emission is BEST-EFFORT: a failure to append a plan-event must
 * never break a plan write. emitPlanEventForCaller() catches and
 * silently swallows; the plan-event log is observability, not state.
 */

import { join } from 'node:path';
import { coordDir } from './paths';
import {
  appendCoordLine,
  newMsgId,
  readCoordFile,
  type CoordEnvelope,
} from './envelope';
import {
  resolveAgentIdentity,
  type AgentIdentity,
  type ResolveIdentityCtx,
} from './identity';

export type PlanEventType =
  | 'created'
  | 'status_changed'
  | 'now_updated'
  | 'decision_added'
  | 'item_added'
  | 'item_status_changed'
  | 'promoted'
  | 'completed';

export interface EmitPlanEventOpts {
  planSlug: string;
  event: PlanEventType;
  identity?: AgentIdentity | null;
  before?: unknown;
  after?: unknown;
  detail?: string;
}

export function planEventsFile(): string {
  return join(coordDir(), 'plan-events.jsonl');
}

/** Append one plan_event line. Throws on filesystem failure — use
 *  emitPlanEventForCaller() from a plans:* write verb. */
export async function emitPlanEvent(opts: EmitPlanEventOpts): Promise<void> {
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: opts.identity?.ownerId ?? 'system',
    to: ['*'],
    kind: 'plan_event',
    plan_slug: opts.planSlug,
    event: opts.event,
  };
  if (opts.before !== undefined) env.before = opts.before;
  if (opts.after !== undefined) env.after = opts.after;
  if (opts.detail !== undefined) env.detail = opts.detail;
  await appendCoordLine(planEventsFile(), env);
}

/**
 * Best-effort emit used by `plans:*` write verbs. Resolves the
 * caller's identity (falling back to `'system'` if unresolvable) and
 * swallows any error — emission must NEVER break a plan write.
 */
export async function emitPlanEventForCaller(
  ctx: ResolveIdentityCtx,
  details: Omit<EmitPlanEventOpts, 'identity'>,
): Promise<void> {
  try {
    let identity: AgentIdentity | null = null;
    try {
      identity = resolveAgentIdentity(ctx);
    } catch {
      identity = null;
    }
    await emitPlanEvent({ ...details, identity });
  } catch {
    // Best-effort. Observability, not state.
  }
}

export interface ReadPlanEventsOpts {
  since_ts?: string;
  planSlugs?: string[];
  events?: PlanEventType[];
}

/** Read the plan-event log, filtered. Sorted by ts ascending. */
export async function readPlanEvents(
  opts: ReadPlanEventsOpts = {},
): Promise<CoordEnvelope[]> {
  const lines = await readCoordFile(planEventsFile());
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  const slugFilter = opts.planSlugs ? new Set(opts.planSlugs) : null;
  const eventFilter = opts.events
    ? new Set<string>(opts.events as readonly string[])
    : null;
  const out: CoordEnvelope[] = [];
  for (const l of lines) {
    if (l.kind !== 'plan_event') continue;
    if (sinceMs && new Date(l.ts).getTime() <= sinceMs) continue;
    const slug = typeof l.plan_slug === 'string' ? l.plan_slug : null;
    if (slugFilter && (!slug || !slugFilter.has(slug))) continue;
    const ev = typeof l.event === 'string' ? l.event : null;
    if (eventFilter && (!ev || !eventFilter.has(ev))) continue;
    out.push(l);
  }
  out.sort(
    (a, b) =>
      a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id),
  );
  return out;
}
