/**
 * injection-block-cache — bound the pre-turn memory injection's prompt-build
 * cost on the converse path (papercup-chat-release-grade-loop-2026-07-16
 * P-010, evidence EI-13232 / plan decision D-004).
 *
 * buildMemoryContextBlock is internally deadline-capped (MEMORY_INJECT_TIMEOUT_MS
 * = 5s per op) but the converse prompt AWAITED it inline — so on a loaded box a
 * typed turn paid the full 5s cap on every search miss (pass-7 drill: searchMs
 * 5001–5114, the dominant prompt-build phase once P-009 took the sentinel
 * gather off the critical path) and then injected NOTHING (timeout ⇒ null ⇒
 * the 60s degraded latch). Worst of both: full latency, zero memory.
 *
 * Same treatment as sentinel-block-cache — the RENDERED block sits behind the
 * operator SWR cache and the caller's wait is capped via getOrSetBounded —
 * with one deliberate difference: **soft TTL = 0**. The block depends on the
 * turn's queryContext (the last user messages), so a cached block is ALWAYS
 * treated as stale: an identical authorized query serves its previous build
 * instantly and revalidates in the background. Changed query/task/principal or
 * control identity gets a cold miss and may abstain; on a fast box a
 * cold miss usually completes under the deadline and behavior matches the
 * unbounded path. The per-turn build cost is unchanged — it just runs off the
 * blocking path.
 *
 * Composition with the existing memory hygiene layers (all inside the build):
 *   - the 2-minute surfaced watermark / session-epoch dedup means consecutive
 *     background rebuilds return mostly-new facts, so a stale-served block is
 *     not re-paid context — it is the SAME text the model already saw;
 *   - a build that times out internally returns null; null is cached
 *     (cacheEmpty) and the degraded latch quiets the background rebuilds, so a
 *     sustained memory outage costs each turn ~0ms, not a 5s probe.
 */

import { getOrSetBounded, type Cache } from '@papercusp/cache';
import { getOrgPg } from '@papercusp/db-org';
import { createHash, randomUUID } from 'node:crypto';
import { getOperatorCache } from '../cache/instance';
import { createMemoryWorkDeadline, MemoryTimeoutError, type MemoryWorkDeadline } from './op-deadline';

/** Revalidate on every read of the same authorized query. */
export const MEMORY_BLOCK_SOFT_TTL_MS = 0;
/** Drop a stale block after this long — a resumed-after-idle conversation
 *  should race a fresh build rather than inject minutes-old recall. */
export const MEMORY_BLOCK_HARD_TTL_MS = 5 * 60_000;
/** Max time a typed turn's prompt build may BLOCK on a cold memory build. */
export const MEMORY_BLOCK_COLD_DEADLINE_MS = 2_000;

/** Invalidation tag — bump via the cache ECA for an eager refresh. */
export const MEMORY_BLOCK_CACHE_TAG = 'memory-inject-block';
/** Base-table tag the generic cache-ECA bumps after a canonical memory write. */
export const MEMORY_CANONICAL_CACHE_TAG = 'memory_canonical';

/** What a block build can ask about the call that started it. */
export interface MemoryBlockBuildContext {
  /**
   * True while the caller still waits on this build: a cold miss, until the
   * caller's wait cap. False once the caller has been answered, which is from the
   * start for a stale-while-revalidate rebuild. A client wall bounds a step only
   * while this is true; after that nobody is left for it to protect.
   */
  readonly callerWaiting: () => boolean;
}

export interface MemoryBlockBoundedOpts {
  /** Launch identity for the authoritative gate BEFORE a stale cache read. */
  sessionId?: string;
  /** Server-resolved inputs also passed to the builder. No client-supplied
   * authorization generation is accepted; the session registry supplies it. */
  retrieval?: {
    principalId: string | null;
    queryText: string;
    taskContext?: string;
    authorizationScope: string;
  };
  /** Override the cold-miss wait cap (sentinel_scan turns have no human waiting). */
  deadlineMs?: number;
  /** Cache instance override (tests). Default: the operator singleton. */
  cache?: Cache;
  softTtlMs?: number;
  hardTtlMs?: number;
}

export type MemoryBlockBoundedResult<T = string> =
  | { status: 'ready'; block: T | null }
  | { status: 'deadline'; block: null }
  | { status: 'error'; block: null };

const normalizeContext = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** Reuse the control registry written by persistControlAnchor. Unknown authority
 * never falls back to the old session-only key. */
async function memoryBlockControlIdentity(workspaceId: string, sessionId: string): Promise<string> {
  const rows = await getOrgPg().sql<{
    generation: number | string; applied: unknown; scope: unknown;
  }[]>`
    SELECT control_generation AS generation,
           control_state->'activation'->'applied' AS applied,
           control_state->'scope' AS scope
      FROM harness_shared.session_briefs
     WHERE owner_id = ${sessionId} AND workspace_id = ${workspaceId}
       AND control_state IS NOT NULL
     LIMIT 1`;
  const row = rows[0];
  if (!row || !Number.isSafeInteger(Number(row.generation)) || Number(row.generation) < 0)
    throw new Error('Memory cache control identity is unavailable.');
  return JSON.stringify([Number(row.generation), row.applied, row.scope]);
}

/**
 * Get the rendered memory-injection block for an authorized retrieval identity, building
 * with `build` (a closure over THIS turn's queryContext). Never rejects: a
 * failed or over-deadline build resolves null (the caller omits the section).
 * `scopeKey` isolates conversations; retrieval inputs and server control state
 * additionally isolate principal, query, task and authorization. A caller that
 * omits retrieval inputs gets bounded builds without cross-call reuse.
 */
export async function getMemoryBlockBoundedResult<T = string>(
  workspaceId: string,
  scopeKey: string,
  build: (deadline: MemoryWorkDeadline, ctx: MemoryBlockBuildContext) => Promise<T | null>,
  opts: MemoryBlockBoundedOpts = {},
): Promise<MemoryBlockBoundedResult<T>> {
  const sessionId = opts.sessionId;
  const deadlineMs = opts.deadlineMs ?? MEMORY_BLOCK_COLD_DEADLINE_MS;
  const started = Date.now();
  let controlIdentity = '';
  if (sessionId) {
    const deadline = createMemoryWorkDeadline(deadlineMs);
    try {
      const allowed = await deadline.run(async () => {
        const { sessionAllowsAmbientContext } = await import('../capability-envelope/session-confinement-port');
        return sessionAllowsAmbientContext({ ownerId: sessionId, workspaceId });
      }, 'memory-cache-policy');
      if (!allowed) return { status: 'ready', block: null };
      controlIdentity = await deadline.run(
        () => memoryBlockControlIdentity(workspaceId, sessionId), 'memory-cache-authority');
    } catch (error) {
      return { status: error instanceof MemoryTimeoutError ? 'deadline' : 'error', block: null };
    }
    finally { deadline.close(); }
  }
  const cache = opts.cache ?? getOperatorCache();
  const tags = [MEMORY_BLOCK_CACHE_TAG, MEMORY_CANONICAL_CACHE_TAG];
  const sourceIdentity = () => JSON.stringify(cache.generationSnapshot(workspaceId, tags));
  const sourceGeneration = sourceIdentity();
  const retrieval = opts.retrieval;
  // Missing retrieval inputs are safe for legacy callers, but cannot reuse a
  // rendered value. Only identical authorized queries share a single flight.
  const identity = retrieval ? JSON.stringify([
    scopeKey, sessionId ?? null, retrieval.principalId, normalizeContext(retrieval.queryText),
    normalizeContext(retrieval.taskContext ?? ''), retrieval.authorizationScope, controlIdentity, sourceGeneration,
  ]) : randomUUID();
  const key = `memory-inject-block:v2:${createHash('sha256').update(identity).digest('hex')}`;
  // Flips once this call has returned: after a stale serve (the build is then a
  // background revalidate) or after the caller's wait cap. Read lazily, at the
  // moment a build step sizes a wait, never captured at build start: a stale hit
  // can start the revalidate before this call has returned.
  let callerAnswered = false;
  const ctx: MemoryBlockBuildContext = { callerWaiting: () => !callerAnswered };

  const res = await getOrSetBounded<T | null>(
    cache,
    workspaceId,
    key,
    async () => {
      // Created only for an actual single-flight build, never for a cache hit
      // or a coalesced waiter. SWR and the caller's wait retain their semantics.
      const deadline = createMemoryWorkDeadline(deadlineMs);
      try { return await build(deadline, ctx); }
      finally { deadline.close(); }
    },
    {
      deadlineMs: Math.max(0, deadlineMs - (Date.now() - started)),
      softTtlMs: opts.softTtlMs ?? MEMORY_BLOCK_SOFT_TTL_MS,
      hardTtlMs: opts.hardTtlMs ?? MEMORY_BLOCK_HARD_TTL_MS,
      // The memory-write path publishes a synthetic memory_canonical.changed
      // event through sync-sse. The generic cache-ECA bumps this base-table tag
      // in every listening process, so the next prompt cannot serve a superseded
      // block from its process-local SWR cache.
      tags,
      // A null block (no hits / degraded store) is a completed build — cache it
      // so a quiet or degraded store isn't re-probed on the blocking path.
      cacheEmpty: true,
    },
  );
  callerAnswered = true;
  if (res.ok) {
    if (sessionId) {
      const deadline = createMemoryWorkDeadline(Math.max(0, deadlineMs - (Date.now() - started)));
      try {
        const { sessionAllowsAmbientContext } = await import('../capability-envelope/session-confinement-port');
        if (!await deadline.run(() => sessionAllowsAmbientContext({
          ownerId: sessionId, workspaceId,
        }), 'memory-cache-policy') || controlIdentity !== await deadline.run(
          () => memoryBlockControlIdentity(workspaceId, sessionId), 'memory-cache-authority'))
          return { status: 'ready', block: null };
      } catch { return { status: 'error', block: null }; }
      finally { deadline.close(); }
    }
    // A source write during a build or the final policy read invalidates THIS
    // response too. The generation in the key prevents later callers joining
    // the obsolete flight, using the cache's existing ECA clock.
    if (sourceIdentity() !== sourceGeneration) return { status: 'error', block: null };
    return { status: 'ready', block: res.value };
  }
  if (res.reason === 'deadline') {
    // The single-flight build keeps running and will serve the NEXT turn;
    // this turn proceeds without the section.
    console.warn(
      `[memory-injection] block build exceeded the ${deadlineMs}ms prompt-build deadline — ` +
        'omitting the section this turn; the in-flight build will serve the next one (P-010).',
    );
    return { status: 'deadline', block: null };
  }
  console.warn(
    '[memory-injection] block build failed (omitting the section):',
    res.error instanceof Error ? res.error.message : String(res.error),
  );
  return { status: 'error', block: null };
}

/**
 * Compatibility surface for callers that only render the block. Delivery
 * instrumentation should use `getMemoryBlockBoundedResult`: a completed
 * no-hit build and a deadline both render as null, but they are not the same
 * reading and must never share a healthy `no-recall` metric.
 */
export async function getMemoryBlockBounded(
  workspaceId: string,
  scopeKey: string,
  build: (deadline: MemoryWorkDeadline, ctx: MemoryBlockBuildContext) => Promise<string | null>,
  opts: MemoryBlockBoundedOpts = {},
): Promise<string | null> {
  return (await getMemoryBlockBoundedResult(workspaceId, scopeKey, build, opts)).block;
}
