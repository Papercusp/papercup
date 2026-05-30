/**
 * plan-events.ts — operator host adapter for the working-memory history
 * feed.
 *
 * Event types + the read filter live in @papercusp/coordination/core; the
 * append + monthly-rotation I/O lives behind the CoordEventLog seam
 * (coordLog). `planEventsFile` / `listPlanEventsFiles` remain exported
 * (diagnostics + tests); they recompute the same fs layout the seam uses.
 *
 * agent-coordination-architecture-v2 §8. Emission is BEST-EFFORT — a
 * failure must never break a plan write (emitPlanEventForCaller swallows).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  newMsgId,
  filterPlanEvents,
  type CoordEnvelope,
  type PlanEventType,
  type ReadPlanEventsOpts,
} from '@papercusp/coordination/core';
import { coordDir } from './paths';
import { coordLog } from './log';
import {
  resolveAgentIdentity,
  type AgentIdentity,
  type ResolveIdentityCtx,
} from './identity';

export type { PlanEventType, ReadPlanEventsOpts };

export interface EmitPlanEventOpts {
  planSlug: string;
  event: PlanEventType;
  identity?: AgentIdentity | null;
  before?: unknown;
  after?: unknown;
  detail?: string;
}

const PLAN_EVENTS_MONTHLY_RE = /^plan-events-\d{4}-\d{2}\.jsonl$/;

/**
 * The plan-events file for a given month (default: current). Monthly
 * rotation (`coord/plan-events-<YYYY-MM>.jsonl`) keeps any single file
 * bounded; reads concatenate across files.
 */
export function planEventsFile(date: Date = new Date()): string {
  const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return join(coordDir(), `plan-events-${ym}.jsonl`);
}

/**
 * All plan-events files in coord/, oldest→newest: the legacy un-suffixed
 * file first (pre-rotation history), then the monthly files in lexical
 * (= chronological) order.
 */
export async function listPlanEventsFiles(): Promise<string[]> {
  const dir = coordDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const out: string[] = [];
  if (entries.includes('plan-events.jsonl')) out.push(join(dir, 'plan-events.jsonl'));
  for (const f of entries.filter((x) => PLAN_EVENTS_MONTHLY_RE.test(x)).sort()) {
    out.push(join(dir, f));
  }
  return out;
}

/** Append one plan_event line. Throws on fs failure — prefer
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
  await coordLog.appendLine('plan-events', env.from, env);
}

/**
 * Best-effort emit used by `plans:*` write verbs. Resolves the caller's
 * identity (falling back to 'system' if unresolvable) and swallows any
 * error — emission must NEVER break a plan write.
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

/** Read the plan-event log across all monthly rotation files, filtered.
 *  Sorted by ts ascending. */
export async function readPlanEvents(
  opts: ReadPlanEventsOpts & { filesBack?: number } = {},
): Promise<CoordEnvelope[]> {
  const filesBack =
    typeof opts.filesBack === 'number' && opts.filesBack > 0 ? opts.filesBack : undefined;
  const lines = await coordLog.readLines('plan-events', filesBack ? { filesBack } : undefined);
  return filterPlanEvents(lines, opts);
}
