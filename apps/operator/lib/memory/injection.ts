/**
 * Centralized pre-turn memory-injection helper.
 *
 * Returns a markdown block to splice into a chat route's system prompt.
 * Caller pattern:
 *
 *   const block = await buildMemoryContextBlock({
 *     userId: sessionUser.id,
 *     workspaceId,
 *     queryContext: lastFewUserMessages,
 *   });
 *   if (block) sections.push(block);
 *
 * Same shape used by operator-converse today. Designed so the other
 * chat routes (architect.chat, brainstorm.chat, delegate-chat) can
 * adopt the exact same behavior with a 1-line call once the
 * sse-typed-events branch lands.
 *
 * Best-effort: any failure (mem0 unavailable, PG down, embedder
 * misconfigured, no hits) returns null and the caller's prompt is
 * unaffected. Never throws.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getMemoryClient } from './mem0-client';
import { bumpLastSurfacedSql } from './bump-last-surfaced';

/**
 * mem0 memory injection is a best-effort enhancement — never
 * load-bearing — and it must never *hang*. `buildOperatorPrompt`
 * awaits this helper inline, so a slow/stuck embedder (e.g. the local
 * BGE ONNX model downloading on first use when no OpenAI key is set)
 * would otherwise block the entire operator turn — the failure mode
 * observed 2026-05-21 where operator-converse emitted only SSE
 * heartbeats and never produced a turn.
 *
 * Every mem0 call here is bounded by MEMORY_OP_TIMEOUT_MS. The first
 * timeout drops the whole process into a degraded mode so later turns
 * skip mem0 instantly instead of paying the timeout on every turn.
 * The flag resets on restart; mem0-client's own TTL + poison-cache
 * handle client-level recovery.
 */
const MEMORY_OP_TIMEOUT_MS = 5_000;
let memoryDegraded = false;

class MemoryTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MemoryTimeoutError(`mem0 ${label} exceeded ${MEMORY_OP_TIMEOUT_MS}ms`));
    }, MEMORY_OP_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function noteMemoryFailure(err: unknown): void {
  if (err instanceof MemoryTimeoutError) {
    memoryDegraded = true;
    console.warn(`[memory-injection] ${err.message} — mem0 disabled for this process`);
  }
}

export interface MemoryInjectionInput {
  /**
   * Per-user memory scope. Omit (or pass null) on workspace-bearer
   * routes that don't have a session user — the helper will then
   * inject only the harness/workspace pools.
   */
  userId?: string | null;
  workspaceId: string;
  /**
   * Harness slugs whose shared memory should be pulled into recall.
   * Agent inside one harness: pass `[currentSlug]`. Operator chat
   * (no specific harness): pass every harness the session user has
   * access to. Omit/[] to skip the harness pool entirely.
   */
  harnessSlugs?: readonly string[];
  /** Recent user-turn content concatenated. Empty string returns null. */
  queryContext: string;
  /** Defaults to 6. */
  limit?: number;
  /** Defaults to "Operator memory (relevant entries)". */
  heading?: string;
}

/**
 * Cap the number of harness pools fanned out per turn. Each pool is
 * an independent mem0.search() (= one embed + one pgvector query).
 * 20 is fine on local pgvector; if a workspace exceeds this we slice
 * and log a warning — the optimization path (embed once + custom
 * SQL with IN()) is documented in the memory-harness-scope plan.
 */
const MAX_HARNESS_FANOUT = 20;
/** Hits requested per harness pool. Kept small so the merged section stays bounded. */
const PER_HARNESS_LIMIT = 3;

export async function buildMemoryContextBlock(
  input: MemoryInjectionInput,
): Promise<string | null> {
  if (!input.queryContext.trim()) return null;
  if (memoryDegraded) return null;

  let client;
  try {
    client = await withTimeout(getMemoryClient(), 'getMemoryClient');
  } catch (err) {
    noteMemoryFailure(err);
    return null;
  }
  if (!client) return null;

  const userLimit = input.limit ?? 6;
  // When there's a user pull, share the budget with workspace half-and-half;
  // when no user (workspace-only / agent-bearer routes), workspace gets full.
  const workspaceLimit = input.userId ? Math.ceil(userLimit / 2) : userLimit;

  let harnessSlugs = (input.harnessSlugs ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  if (harnessSlugs.length > MAX_HARNESS_FANOUT) {
    console.warn(
      `[memory-injection] harnessSlugs (${harnessSlugs.length}) exceeds MAX_HARNESS_FANOUT (${MAX_HARNESS_FANOUT}); slicing.`,
    );
    harnessSlugs = harnessSlugs.slice(0, MAX_HARNESS_FANOUT);
  }

  type Hit = { memory: string; metadata?: Record<string, unknown> };
  type Hits = { results?: Array<Hit> };
  let userHits: Hits = {};
  let workspaceHits: Hits = {};
  let harnessHitsByPool: Hits[] = [];
  try {
    const userPull: Promise<Hits> = input.userId
      ? (client.search(input.queryContext, {
          filters: { user_id: input.userId },
          limit: userLimit,
        }) as Promise<Hits>)
      : Promise.resolve({} as Hits);

    // Legacy workspace pull — back-compat read-through during deprecation
    // window. Once all `workspace:*` entries are drained, this and the
    // "deprecated workspace" UI section can both be removed (see the
    // memory-harness-scope plan, Phase 5).
    const workspacePull: Promise<Hits> = client.search(input.queryContext, {
      filters: { user_id: `workspace:${input.workspaceId}` },
      limit: workspaceLimit,
    }) as Promise<Hits>;

    const harnessPulls: Promise<Hits>[] = harnessSlugs.map((slug) =>
      client.search(input.queryContext, {
        filters: { user_id: `harness:${slug}` },
        limit: PER_HARNESS_LIMIT,
      }) as Promise<Hits>,
    );

    const all = await withTimeout(
      Promise.all([userPull, workspacePull, ...harnessPulls]),
      'search',
    );
    userHits = all[0];
    workspaceHits = all[1];
    harnessHitsByPool = all.slice(2);
  } catch (err) {
    noteMemoryFailure(err);
    if (!(err instanceof MemoryTimeoutError) && process.env.NODE_ENV !== 'test') {
      console.warn('[memory-injection] search failed:', (err as Error).message);
    }
    return null;
  }

  const harnessHits = harnessSlugs.flatMap((slug, i) =>
    (harnessHitsByPool[i]?.results ?? []).map((h) => ({ hit: h, slug })),
  );
  const userResults = userHits.results ?? [];
  const workspaceResults = workspaceHits.results ?? [];
  if (userResults.length + workspaceResults.length + harnessHits.length === 0) return null;

  const fmtScope = (meta: Record<string, unknown>, slug?: string): string => {
    const kind = (meta.kind as string) ?? 'unknown';
    if (slug) return `[${kind} @ ${slug}]`;
    if (meta.shared || meta.scope === 'workspace') return `[${kind} [shared]]`;
    return `[${kind}]`;
  };

  // Phase 5 P-020: surface memory_id alongside each entry so the agent
  // can call memory:forget when a user correction contradicts an
  // injected memory. Suffix-style to keep the existing `[kind] <text>`
  // format backward-compatible.
  const fmtId = (h: { id?: string }): string =>
    typeof h.id === 'string' && h.id ? ` (id=${h.id})` : '';

  const lines: string[] = [];
  for (const h of userResults) lines.push(`- ${fmtScope((h.metadata ?? {}) as Record<string, unknown>)}${fmtId(h as { id?: string })} ${h.memory}`);
  for (const { hit, slug } of harnessHits) lines.push(`- ${fmtScope((hit.metadata ?? {}) as Record<string, unknown>, slug)}${fmtId(hit as { id?: string })} ${hit.memory}`);
  for (const h of workspaceResults) lines.push(`- ${fmtScope((h.metadata ?? {}) as Record<string, unknown>)}${fmtId(h as { id?: string })} ${h.memory}`);

  // Phase 5 P-021: stamp last_surfaced_at on every memory we surfaced
  // so Layer 3 (deferred) can target "memories actually used recently"
  // for revalidation. Fire-and-forget: bumpLastSurfacedSql is fully
  // defensive (column-missing cached, transient errors swallowed) and
  // its outcome doesn't affect the injection block we return.
  type HitWithId = { id?: string };
  const surfacedIds: string[] = [];
  for (const h of userResults) if ((h as HitWithId).id) surfacedIds.push((h as HitWithId).id!);
  for (const { hit } of harnessHits) if ((hit as HitWithId).id) surfacedIds.push((hit as HitWithId).id!);
  for (const h of workspaceResults) if ((h as HitWithId).id) surfacedIds.push((h as HitWithId).id!);
  if (surfacedIds.length > 0) {
    void (async () => {
      try {
        const { sql } = getOrgPg();
        await bumpLastSurfacedSql(sql, surfacedIds);
      } catch {
        /* swallow — never load-bearing */
      }
    })();
  }

  const heading = input.heading ?? 'Operator memory (relevant entries)';
  return `## ${heading}\n\n${lines.join('\n')}`;
}

/**
 * Convenience: pull the last N user-turn contents joined with newlines.
 * Matches the contract operator-converse already uses (default N=3).
 */
export function lastUserContext(
  messages: ReadonlyArray<{ role: string; content: string }>,
  count = 3,
): string {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-count)
    .map((m) => m.content)
    .join('\n');
}
