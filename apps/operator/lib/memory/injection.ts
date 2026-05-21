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

import { getMemoryClient } from './mem0-client';

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
   * inject only workspace-shared memories.
   */
  userId?: string | null;
  workspaceId: string;
  /** Recent user-turn content concatenated. Empty string returns null. */
  queryContext: string;
  /** Defaults to 6. The shared-workspace pull adds ceil(limit/2) more. */
  limit?: number;
  /** Defaults to "Operator memory (relevant entries)". */
  heading?: string;
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
  const sharedLimit = Math.ceil(userLimit / 2);

  type Hits = { results?: Array<{ memory: string; metadata?: Record<string, unknown> }> };
  let userHits: Hits = {};
  let sharedHits: Hits = {};
  try {
    const pulls: Array<Promise<Hits>> = [];
    if (input.userId) {
      pulls.push(
        client.search(input.queryContext, {
          filters: { user_id: input.userId },
          limit: userLimit,
        }) as Promise<Hits>,
      );
    } else {
      pulls.push(Promise.resolve({} as Hits));
    }
    pulls.push(
      client.search(input.queryContext, {
        filters: { user_id: `workspace:${input.workspaceId}` },
        limit: input.userId ? sharedLimit : userLimit,
      }) as Promise<Hits>,
    );
    [userHits, sharedHits] = await withTimeout(Promise.all(pulls), 'search');
  } catch (err) {
    noteMemoryFailure(err);
    if (!(err instanceof MemoryTimeoutError) && process.env.NODE_ENV !== 'test') {
      console.warn('[memory-injection] search failed:', (err as Error).message);
    }
    return null;
  }

  const combined = [
    ...(userHits.results ?? []),
    ...(sharedHits.results ?? []),
  ];
  if (combined.length === 0) return null;

  const lines = combined.map((hit) => {
    const meta = (hit.metadata ?? {}) as Record<string, unknown>;
    const kind = (meta.kind as string) ?? 'unknown';
    const shared = meta.shared ? ' [shared]' : '';
    return `- [${kind}${shared}] ${hit.memory}`;
  });
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
