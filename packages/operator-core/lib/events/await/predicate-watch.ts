/**
 * Predicate watches — engine-side "wake me when <tool result crosses a threshold>"
 * (fleet-deltas-leader-primitives-2026-07-10 P-008; table: migration 541).
 *
 * The registration surface is `watch:create { predicate, interval_sec }`. The engine
 * polls a READ-ONLY projected tool every interval under THE REGISTRANT'S ROLE
 * ENVELOPE (the role gate is enforced on every poll — gateBypass covers only
 * capability + quota), extracts a dot-path from the result, compares it with an op
 * against a stored operand, and on a false→true EDGE fires the paired await row via
 * `emitAwaitedEvent({ key: 'predicate:<id>' })` — so floors, coalescing, once
 * semantics, timeout-wake and delivery all reuse the existing wake machinery for
 * free. Kills the polling-vigil pattern (a leader burning wake turns re-reading a
 * watermark).
 *
 * Lifecycle is self-cleaning: rows deactivate on fire (once), on 5 consecutive poll
 * errors (with a predicateError emit so the waiter wakes instead of dangling), and
 * by GC when the paired event_awaits registration dies (cancelled / consumed /
 * timed out / TTL-lapsed) — events:cancel needs no coupling to this table.
 *
 * Poll claiming is stamp-based (`last_polled_at = now()` inside FOR UPDATE SKIP
 * LOCKED) so the multiple hosts that run this poller (dev shell, :3170, :3070)
 * never double-poll a row in the same window.
 *
 * fleet-reliability-verification-2026-07-10 P-004: `findMatchingActivePredicateWatch`
 * adds registration-time DEDUPE — a second caller registering the identical
 * predicate joins the existing row's poller instead of starting a second one (the
 * exact repro this closes: two agents each independently polling the same watermark
 * SQL ~12+ times during the 2026-07-09/10 night shift).
 */

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import {
  lookupByMcpName,
  dispatchProjectedTool,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { emitAwaitedEvent } from './engine';

/* eslint-disable @typescript-eslint/no-explicit-any */

const POLL_TICK_MS = 10_000;
const POLL_BATCH_LIMIT = 20;
/** After this many consecutive poll errors the row deactivates AND emits a
 *  predicateError payload on its key, so the waiter wakes instead of dangling. */
export const PREDICATE_MAX_CONSECUTIVE_ERRORS = 5;

export const PREDICATE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];

export interface PredicateWatchRow {
  id: string;
  workspaceId: string;
  ownerId: string;
  role: string;
  harnessSlug: string | null;
  eventKey: string;
  tool: string;
  args: Record<string, unknown>;
  path: string;
  op: PredicateOp;
  value: unknown;
  intervalSec: number;
  once: boolean;
  lastEval: boolean | null;
  lastValue: unknown;
  lastPolledAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  active: boolean;
  createdAt: string;
}

function log(msg: string): void {
  console.error(`[predicate-watch] ${msg}`);
}

/** jsonb arrives parsed OR as text depending on the postgres-js client config
 *  (the repo's known sql.json quirk) — tolerate both. */
function parseJsonb<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function mapRow(r: any): PredicateWatchRow {
  return {
    id: String(r.id),
    workspaceId: r.workspace_id,
    ownerId: r.owner_id,
    role: r.role,
    harnessSlug: r.harness_slug ?? null,
    eventKey: r.event_key,
    tool: r.tool,
    args: parseJsonb<Record<string, unknown>>(r.args) ?? {},
    path: r.path,
    op: r.op as PredicateOp,
    value: parseJsonb(r.value),
    intervalSec: Number(r.interval_sec),
    once: Boolean(r.once),
    lastEval: r.last_eval == null ? null : Boolean(r.last_eval),
    lastValue: parseJsonb(r.last_value),
    lastPolledAt: r.last_polled_at ? new Date(r.last_polled_at).toISOString() : null,
    lastError: r.last_error ?? null,
    consecutiveErrors: Number(r.consecutive_errors ?? 0),
    active: Boolean(r.active),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/* ── Pure helpers (unit-tested) ────────────────────────────────────────────── */

/** Dot-path extraction: `counts.open`, `rows.0.status`. Array indices are plain
 *  numeric segments. Missing anywhere along the path ⇒ undefined. */
export function valueAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Evaluate `observed <op> value`. Numeric ops coerce both sides via Number()
 *  and are false on non-finite operands (never throw on a shape surprise). */
export function comparePredicate(observed: unknown, op: PredicateOp, value: unknown): boolean {
  switch (op) {
    case 'exists':
      return observed !== undefined && observed !== null;
    case 'eq':
      return deepEq(observed, value);
    case 'ne':
      return !deepEq(observed, value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(observed);
      const b = Number(value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
    case 'contains': {
      if (typeof observed === 'string') return observed.includes(String(value));
      if (Array.isArray(observed)) return observed.some((el) => deepEq(el, value));
      return false;
    }
  }
}

/** Pull the comparable payload out of a ToolResult: structuredContent when present,
 *  else a tolerant JSON.parse of the first text content block (raw string if it
 *  isn't JSON). */
export function extractToolPayload(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } | null;
  if (r == null) return null;
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = r.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return r;
}

/* ── Store ─────────────────────────────────────────────────────────────────── */

export async function registerPredicateWatch(input: {
  /** Pre-generated id — the caller registers the await on `predicate:<id>` FIRST
   *  (GC safety: a row must never exist without its paired await). */
  id: string;
  workspaceId: string;
  ownerId: string;
  /** The registrant's role — every poll dispatches under THIS role with the role
   *  gate enforced. */
  role: string;
  harnessSlug?: string | null;
  eventKey: string;
  tool: string;
  args?: Record<string, unknown>;
  path: string;
  op: PredicateOp;
  value?: unknown;
  intervalSec?: number;
  once?: boolean;
}): Promise<PredicateWatchRow> {
  const { sql } = getOrgPg();
  const rows = await sql`
    INSERT INTO harness_shared.predicate_watches
      (id, workspace_id, owner_id, role, harness_slug, event_key, tool, args, path, op, value,
       interval_sec, once, last_polled_at)
    VALUES
      (${input.id}, ${input.workspaceId}, ${input.ownerId}, ${input.role},
       ${input.harnessSlug ?? null}, ${input.eventKey}, ${input.tool},
       ${JSON.stringify(input.args ?? {})}::text::jsonb, ${input.path}, ${input.op},
       ${input.value === undefined ? null : JSON.stringify(input.value)}::text::jsonb,
       ${input.intervalSec ?? 60}, ${input.once ?? true},
       -- stamp now(): registration runs ONE inline eval itself, so the poller's
       -- first pickup is one interval out, not immediately after.
       now())
    RETURNING *
  `;
  return mapRow(rows[0]);
}

export async function getPredicateWatch(id: string): Promise<PredicateWatchRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql`SELECT * FROM harness_shared.predicate_watches WHERE id = ${id}`;
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * EI-8998 dedup (fleet-reliability-verification-2026-07-10 P-004): find an ACTIVE row
 * already polling the IDENTICAL predicate — same authority scope (workspace/role/
 * harness, since a poll dispatches under the REGISTRANT's role envelope and must
 * never silently borrow a different registrant's authority) and the same poll target
 * + cardinality (tool/args/path/op/value/interval_sec/once). jsonb equality is
 * structural (key order doesn't matter), so `args`/`value` compare correctly without
 * a canonicalization step.
 *
 * Best-effort, not a hard DB constraint: two registrations racing within the same
 * tick can still each insert a row (no unique index backs this), but the motivating
 * repro — two agents independently registering the same watermark predicate minutes
 * apart during a vigil — collapses to ONE polled row. The caller (watch:create) is
 * responsible for attaching the new subscriber's `event_awaits` row to the MATCH's
 * `eventKey` instead of calling `registerPredicateWatch` again.
 */
export async function findMatchingActivePredicateWatch(input: {
  workspaceId: string;
  role: string;
  harnessSlug?: string | null;
  tool: string;
  args?: Record<string, unknown>;
  path: string;
  op: PredicateOp;
  value?: unknown;
  intervalSec?: number;
  once?: boolean;
}): Promise<PredicateWatchRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT * FROM harness_shared.predicate_watches
     WHERE active
       AND workspace_id = ${input.workspaceId}
       AND role = ${input.role}
       AND harness_slug IS NOT DISTINCT FROM ${input.harnessSlug ?? null}
       AND tool = ${input.tool}
       AND args = ${JSON.stringify(input.args ?? {})}::text::jsonb
       AND path = ${input.path}
       AND op = ${input.op}
       AND value IS NOT DISTINCT FROM ${input.value === undefined ? null : JSON.stringify(input.value)}::text::jsonb
       AND interval_sec = ${input.intervalSec ?? 60}
       AND once = ${input.once ?? true}
     ORDER BY created_at ASC
     LIMIT 1
  `;
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Claim-by-stamp the due rows (active + past their interval), FOR UPDATE SKIP
 *  LOCKED so concurrent host pollers split the set instead of double-polling. */
export async function claimDuePredicateWatches(limit = POLL_BATCH_LIMIT): Promise<PredicateWatchRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql`
    UPDATE harness_shared.predicate_watches
       SET last_polled_at = now()
     WHERE id IN (
       SELECT id FROM harness_shared.predicate_watches
        WHERE active
          AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => interval_sec))
        ORDER BY last_polled_at ASC NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `;
  return rows.map(mapRow);
}

/** Deactivate rows whose paired await registration is gone. A once-await is live
 *  while unfired+uncancelled; a standing await is live while uncancelled and
 *  unexpired (standing fires never set fired_at — they match without consuming). */
export async function gcOrphanedPredicateWatches(): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql`
    UPDATE harness_shared.predicate_watches pw
       SET active = false,
           last_error = coalesce(pw.last_error, 'gc: paired event_awaits registration gone (cancelled/consumed/expired)')
     WHERE pw.active
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.event_awaits ea
          WHERE ea.workspace_id = ${DEFAULT_COORD_WORKSPACE}
            AND ea.event_key = pw.event_key
            AND ea.cancelled_at IS NULL
            AND ((ea.once = true AND ea.fired_at IS NULL)
              OR (ea.once = false AND (ea.expires_ts IS NULL OR ea.expires_ts > now())))
       )
    RETURNING pw.id
  `;
  return rows.length;
}

async function recordPredicateEval(
  id: string,
  input: { lastEval: boolean; lastValue: unknown; deactivate: boolean },
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.predicate_watches
       SET last_eval = ${input.lastEval},
           last_value = ${input.lastValue === undefined ? null : JSON.stringify(input.lastValue)}::text::jsonb,
           last_polled_at = now(),
           last_error = NULL,
           consecutive_errors = 0,
           active = active AND NOT ${input.deactivate}
     WHERE id = ${id}
  `;
}

async function recordPredicateError(id: string, message: string, deactivate: boolean): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.predicate_watches
       SET last_error = ${message.slice(0, 2000)},
           last_polled_at = now(),
           consecutive_errors = consecutive_errors + 1,
           active = active AND NOT ${deactivate}
     WHERE id = ${id}
  `;
}

/* ── Dispatch (the role-enveloped poll) ────────────────────────────────────── */

export type PredicateDispatchFn = (row: PredicateWatchRow) => Promise<unknown>;

let dispatchOverride: PredicateDispatchFn | null = null;

/** Test seam: replace the projected-tool dispatch with a fake (null restores). */
export function configurePredicateDispatch(fn: PredicateDispatchFn | null): void {
  dispatchOverride = fn;
}

/**
 * One poll of the row's tool through the NORMAL dispatcher, under the registrant's
 * role envelope. Mirrors events/dispatch-reaction.ts's ctx EXCEPT: `role` is the
 * STORED registrant role and gateBypass covers only { capability, quota } — the
 * ROLE GATE IS ENFORCED on every poll, so a role that loses access to the tool
 * stops being able to poll it (the resulting errors deactivate the row). Audited
 * via tool_invocations like every dispatch (spawnId 'predicate-watch').
 */
async function dispatchPredicateTool(row: PredicateWatchRow): Promise<unknown> {
  const projected = lookupByMcpName(row.tool);
  if (!projected) throw new Error(`unknown tool "${row.tool}"`);
  if (projected.effect !== 'read') throw new Error(`tool "${row.tool}" is not read-only (effect=${projected.effect ?? 'unset'})`);
  const result = await withWorkspace(row.workspaceId, async (tx) => {
    const ctx: UnifiedToolContext = {
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug ?? '*',
      role: row.role,
      featureId: null,
      chunkId: null,
      runId: globalThis.crypto.randomUUID(),
      spawnId: 'predicate-watch',
      parentSpawnId: null,
      uiClientId: null,
      isSuperuser: false,
      gateBypass: { capability: true, quota: true },
      profile: 'engineer',
      transport: 'in_process',
      log: () => {},
      progress: () => {},
      emit: () => {},
      signal: new AbortController().signal,
      principal: {
        slug: `system:predicate-watch:${row.ownerId}`,
        workspaceId: row.workspaceId,
        capabilities: new Set(['*']),
      },
      tx,
    };
    return dispatchProjectedTool(projected, row.tool, row.args, ctx, PROJECTED_DEPS);
  });
  if (!result.ok) {
    throw new Error(result.error ? `${result.error.code}: ${result.error.message}` : 'dispatch failed');
  }
  return extractToolPayload(result.result);
}

/* ── Eval + poller ─────────────────────────────────────────────────────────── */

export interface PredicateEvalResult {
  fired: boolean;
  matched: boolean;
  observed?: unknown;
  error?: string;
  deactivated: boolean;
}

/**
 * One evaluation of one row: dispatch → extract → compare → EDGE-fire (matched
 * while last_eval was not true) the paired await via emitAwaitedEvent. `once`
 * rows deactivate on fire. Errors accumulate; the Nth consecutive one
 * deactivates AND emits a predicateError payload so the waiter wakes.
 */
export async function evalPredicateWatch(row: PredicateWatchRow): Promise<PredicateEvalResult> {
  const dispatch = dispatchOverride ?? dispatchPredicateTool;
  try {
    const payload = await dispatch(row);
    const observed = valueAtPath(payload, row.path);
    const matched = comparePredicate(observed, row.op, row.value);
    const edge = matched && row.lastEval !== true;
    const deactivate = edge && row.once;
    if (edge) {
      await emitAwaitedEvent({
        key: row.eventKey,
        payload: {
          observed,
          predicate: { tool: row.tool, path: row.path, op: row.op, value: row.value },
        },
        summary: `predicate matched: ${row.tool} ${row.path} ${row.op}${row.value === undefined ? '' : ` ${JSON.stringify(row.value)}`} (observed ${String(JSON.stringify(observed)).slice(0, 200)})`,
        source: `predicate-watch:${row.ownerId}`,
      });
    }
    await recordPredicateEval(row.id, { lastEval: matched, lastValue: observed, deactivate });
    return { fired: edge, matched, observed, deactivated: deactivate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const deactivate = row.consecutiveErrors + 1 >= PREDICATE_MAX_CONSECUTIVE_ERRORS;
    await recordPredicateError(row.id, msg, deactivate);
    if (deactivate) {
      // The waiter must wake, not dangle — fire the key with an error payload.
      await emitAwaitedEvent({
        key: row.eventKey,
        payload: {
          predicateError: msg.slice(0, 500),
          predicate: { tool: row.tool, path: row.path, op: row.op, value: row.value },
        },
        summary: `predicate watch DEACTIVATED after ${row.consecutiveErrors + 1} consecutive errors: ${msg.slice(0, 200)}`,
        source: `predicate-watch:${row.ownerId}`,
      });
    }
    return { fired: deactivate, matched: false, error: msg, deactivated: deactivate };
  }
}

/** One poller tick: GC orphans, claim the due batch, evaluate serially (the batch
 *  is capped and each dispatch is a read — bounded work per tick). */
export async function pollDuePredicateWatches(): Promise<{ polled: number; fired: number; gc: number }> {
  const gc = await gcOrphanedPredicateWatches();
  const due = await claimDuePredicateWatches();
  let fired = 0;
  for (const row of due) {
    const r = await evalPredicateWatch(row);
    if (r.fired) fired++;
  }
  return { polled: due.length, fired, gc };
}

type Globals = typeof globalThis & { __papercuspPredicateWatchPollerStarted?: boolean };

/** Idempotent lazy start (mirrors startAwaitSweeper) — called at registration and
 *  from the agent-tools boot path so active rows survive a host restart. */
export function startPredicateWatchPoller(): void {
  const g = globalThis as Globals;
  if (g.__papercuspPredicateWatchPollerStarted) return;
  g.__papercuspPredicateWatchPollerStarted = true;
  managedSetInterval(
    'predicate-watch-poller',
    POLL_TICK_MS,
    () => {
      void pollDuePredicateWatches().catch((e) => log(`poll tick failed: ${e instanceof Error ? e.message : e}`));
    },
    { category: 'global-sweep' },
  );
}
