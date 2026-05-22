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

import { promises as fs } from 'node:fs';
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

/**
 * The plan-event kinds that an actual `plans:*` verb emits. This is
 * deliberately exhaustive over emitters — every member here has a call
 * site (audit F-M3). When a plan-level status verb is added
 * (draft→active→shipped on the frontmatter), reintroduce a
 * `status_changed` / `completed` member here *together with* its
 * emitter — not before.
 *
 * `agent_launched` is emitted by `plans:launch` (plan-agent-launch
 * P-014) — not a document write, but a plan-scoped event the activity
 * feed surfaces. A *resume* is run-internal and emits no plan-event:
 * the launch is the plan-level fact; continuations live in the run's
 * own transcript.
 */
export type PlanEventType =
  | 'created'
  | 'now_updated'
  | 'decision_added'
  | 'item_added'
  | 'item_status_changed'
  | 'promoted'
  | 'agent_launched';

export interface EmitPlanEventOpts {
  planSlug: string;
  event: PlanEventType;
  identity?: AgentIdentity | null;
  before?: unknown;
  after?: unknown;
  detail?: string;
}

/**
 * The plan-events file for a given month (default: current month).
 * `coord/plan-events-<YYYY-MM>.jsonl` — monthly rotation (plan §8.2)
 * keeps any single file bounded. Emission always targets the current
 * month; reads concatenate across files.
 */
export function planEventsFile(date: Date = new Date()): string {
  const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return join(coordDir(), `plan-events-${ym}.jsonl`);
}

/** Pre-rotation single-file path, still read so old history survives. */
function legacyPlanEventsFile(): string {
  return join(coordDir(), 'plan-events.jsonl');
}

const PLAN_EVENTS_MONTHLY_RE = /^plan-events-\d{4}-\d{2}\.jsonl$/;

/**
 * All plan-events files in coord/, oldest→newest: the legacy
 * un-suffixed file first (pre-rotation history), then the monthly
 * files in lexical (= chronological) order.
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
  if (entries.includes('plan-events.jsonl')) out.push(legacyPlanEventsFile());
  for (const f of entries.filter((x) => PLAN_EVENTS_MONTHLY_RE.test(x)).sort()) {
    out.push(join(dir, f));
  }
  return out;
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
  /** Read only the most-recent N rotation files (legacy file counts as
   *  one). Omit to read every file. */
  filesBack?: number;
}

/** Read the plan-event log across all monthly rotation files,
 *  filtered. Sorted by ts ascending. */
export async function readPlanEvents(
  opts: ReadPlanEventsOpts = {},
): Promise<CoordEnvelope[]> {
  const allFiles = await listPlanEventsFiles();
  const files =
    typeof opts.filesBack === 'number' && opts.filesBack > 0
      ? allFiles.slice(-opts.filesBack)
      : allFiles;
  const lines: CoordEnvelope[] = [];
  for (const f of files) {
    lines.push(...(await readCoordFile(f)));
  }
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
