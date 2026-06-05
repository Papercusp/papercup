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
import { bumpLastSurfacedSql, recentlySurfacedIds } from './bump-last-surfaced';

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

/**
 * Watermark window for the pre-turn dedup (docs-and-memory-as-projections D-006):
 * a memory surfaced within this window is NOT re-injected this turn, so a stable
 * fact stops being paid for turn-over-turn within a session. Long enough to span
 * back-to-back turns; short enough that a memory re-surfaces after a real pause.
 * Tunable via env; evaluated at call time so tests can flip it.
 */
function reinjectWindowMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_REINJECT_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
}

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

  let harnessSlugs = (input.harnessSlugs ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  if (harnessSlugs.length > MAX_HARNESS_FANOUT) {
    console.warn(
      `[memory-injection] harnessSlugs (${harnessSlugs.length}) exceeds MAX_HARNESS_FANOUT (${MAX_HARNESS_FANOUT}); slicing.`,
    );
    harnessSlugs = harnessSlugs.slice(0, MAX_HARNESS_FANOUT);
  }

  // mem0 holds only STABLE facts now — user + harness scopes (D-005: mem0 is the
  // sole semantic store; the deprecated `workspace:`/`shared` scope is drained, so
  // there is no workspace pull).
  type Hit = { id?: string; memory: string; metadata?: Record<string, unknown> };
  type Hits = { results?: Array<Hit> };
  let userHits: Hits = {};
  let harnessHitsByPool: Hits[] = [];
  try {
    const userPull: Promise<Hits> = input.userId
      ? (client.search(input.queryContext, {
          filters: { user_id: input.userId },
          limit: userLimit,
        }) as Promise<Hits>)
      : Promise.resolve({} as Hits);

    const harnessPulls: Promise<Hits>[] = harnessSlugs.map((slug) =>
      client.search(input.queryContext, {
        filters: { user_id: `harness:${slug}` },
        limit: PER_HARNESS_LIMIT,
      }) as Promise<Hits>,
    );

    const all = await withTimeout(Promise.all([userPull, ...harnessPulls]), 'search');
    userHits = all[0];
    harnessHitsByPool = all.slice(1);
  } catch (err) {
    noteMemoryFailure(err);
    if (!(err instanceof MemoryTimeoutError) && process.env.NODE_ENV !== 'test') {
      console.warn('[memory-injection] search failed:', (err as Error).message);
    }
    return null;
  }

  let userResults = userHits.results ?? [];
  let harnessHits = harnessSlugs.flatMap((slug, i) =>
    (harnessHitsByPool[i]?.results ?? []).map((hit) => ({ hit, slug })),
  );
  if (userResults.length + harnessHits.length === 0) return null;

  // D-006 — the pre-turn dedup: drop any memory surfaced within the recent
  // watermark window so a stable fact is delivered ONCE, not re-injected
  // turn-over-turn. Best-effort: a query failure returns an empty set (no
  // filtering), so the injection degrades to its prior behavior, never breaks.
  const candidateIds = [
    ...userResults.map((h) => h.id),
    ...harnessHits.map(({ hit }) => hit.id),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (candidateIds.length > 0) {
    try {
      const { sql } = getOrgPg();
      const recent = await recentlySurfacedIds(sql, candidateIds, reinjectWindowMs());
      if (recent.size > 0) {
        userResults = userResults.filter((h) => !(h.id && recent.has(h.id)));
        harnessHits = harnessHits.filter(({ hit }) => !(hit.id && recent.has(hit.id)));
      }
    } catch {
      /* swallow — dedup is hygiene, never load-bearing */
    }
  }
  if (userResults.length + harnessHits.length === 0) return null;

  const fmtScope = (meta: Record<string, unknown>, slug?: string): string => {
    const kind = (meta.kind as string) ?? 'unknown';
    if (slug) return `[${kind} @ ${slug}]`;
    return `[${kind}]`;
  };

  // Phase 5 P-020: surface memory_id alongside each entry so the agent
  // can call memory:forget when a user correction contradicts an
  // injected memory. Suffix-style to keep the existing `[kind] <text>`
  // format backward-compatible.
  const fmtId = (h: { id?: string }): string =>
    typeof h.id === 'string' && h.id ? ` (id=${h.id})` : '';

  const lines: string[] = [];
  for (const h of userResults) lines.push(`- ${fmtScope((h.metadata ?? {}) as Record<string, unknown>)}${fmtId(h)} ${h.memory}`);
  for (const { hit, slug } of harnessHits) lines.push(`- ${fmtScope((hit.metadata ?? {}) as Record<string, unknown>, slug)}${fmtId(hit)} ${hit.memory}`);

  // Phase 5 P-021: stamp last_surfaced_at on every memory we surfaced — this is
  // ALSO the dedup watermark the next turn reads. Fire-and-forget: bumpLastSurfacedSql
  // is fully defensive and its outcome doesn't affect the block we return.
  const surfacedIds: string[] = [];
  for (const h of userResults) if (h.id) surfacedIds.push(h.id);
  for (const { hit } of harnessHits) if (hit.id) surfacedIds.push(hit.id);
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
