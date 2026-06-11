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
import { getMemoryBackend, type MemoryEntry } from './backend';
import { bumpLastSurfacedSql, recentlySurfacedIds } from './bump-last-surfaced';
import { hiveScopeKey, hiveSlugFromScope, resolveHiveSlugsForHarnesses } from './hive-scope';

/**
 * Memory injection is a best-effort enhancement — never load-bearing —
 * and it must never *hang*. `buildOperatorPrompt` awaits this helper
 * inline, so a slow/stuck embedder (e.g. the local BGE ONNX model
 * downloading on first use when no OpenAI key is set) would otherwise
 * block the entire operator turn — the failure mode observed 2026-05-21
 * where operator-converse emitted only SSE heartbeats and never
 * produced a turn.
 *
 * Every store call here is bounded by MEMORY_OP_TIMEOUT_MS. The first
 * timeout drops the whole process into a degraded mode so later turns
 * skip the store instantly instead of paying the timeout on every turn.
 * The flag resets on restart; the backend's own caching/poison-cache
 * handles client-level recovery.
 */
const MEMORY_OP_TIMEOUT_MS = 5_000;
let memoryDegraded = false;

class MemoryTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MemoryTimeoutError(`memory ${label} exceeded ${MEMORY_OP_TIMEOUT_MS}ms`));
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
  /**
   * Hive pools to pull (`hive:<slug>` scope — learning-packs P-004). Usually
   * OMITTED: the helper resolves the owning hives from `harnessSlugs` via the
   * registry (member `hive_slug` / `harness_kind:'hive'` home). Pass
   * explicitly to skip that lookup or to recall a hive with no harness in
   * scope; pass `[]` to suppress the hive pull entirely.
   */
  hiveSlugs?: readonly string[];
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

/**
 * Auto-inject relevance floor (memory-backend-improve-and-hybrid P-001 / P-031 / D-003).
 * The PUSH path applies an absolute cosine floor so an off-topic turn is NOT
 * injected with nearest-neighbour noise — the hard-negative FP fix, where there
 * is no LLM in the loop to filter the inject. LOCKED at 0.45 by the P-031 2D
 * sweep (D-006): the push path FAVORS PRECISION (an irrelevant inject pollutes
 * the turn; a missed one is recoverable via the pull path), and 0.45 gives the
 * best precision (~0.95) at the knee of the recall curve (hard-neg FP@5 100%→17%,
 * R@10 ~82%). Note: FP cannot reach ~0% — the bench's hard-negatives genuinely
 * overlap real hits in embedding space. Env-tunable; `<= 0` disables.
 */
function injectMinScore(): number | undefined {
  const raw = Number(process.env.PAPERCUSP_MEMORY_MIN_SCORE);
  if (Number.isFinite(raw)) return raw > 0 ? raw : undefined;
  return 0.45;
}

/**
 * Hybrid-only PUSH lexical-admission bar (P-031 / D-006). The hybrid backend's
 * default lexical bar (0.30) is recall-favoring for the pull path; the no-LLM
 * push path TIGHTENS it to 0.40 so generic lexical token-overlap on an off-topic
 * turn isn't admitted (cuts push FP at a small exact-id cost). Ignored by
 * non-hybrid backends. Env-tunable.
 */
function injectMinLexScore(): number | undefined {
  const raw = Number(process.env.PAPERCUSP_MEMORY_MIN_LEX_SCORE);
  if (Number.isFinite(raw)) return raw >= 0 ? raw : undefined;
  return 0.4;
}

export async function buildMemoryContextBlock(
  input: MemoryInjectionInput,
): Promise<string | null> {
  if (!input.queryContext.trim()) return null;
  if (memoryDegraded) return null;

  const backend = getMemoryBackend();
  try {
    const avail = await withTimeout(backend.available(), 'available()');
    if (!avail.ok) return null;
  } catch (err) {
    noteMemoryFailure(err);
    return null;
  }

  const userLimit = input.limit ?? 6;

  let harnessSlugs = (input.harnessSlugs ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  if (harnessSlugs.length > MAX_HARNESS_FANOUT) {
    console.warn(
      `[memory-injection] harnessSlugs (${harnessSlugs.length}) exceeds MAX_HARNESS_FANOUT (${MAX_HARNESS_FANOUT}); slicing.`,
    );
    harnessSlugs = harnessSlugs.slice(0, MAX_HARNESS_FANOUT);
  }

  // Hive pools (learning-packs P-004): resolve the owning hives from the
  // harness slugs unless the caller pinned them. Best-effort — a registry
  // hiccup degrades to "no hive pull", never blocks the turn.
  let hiveSlugs: string[] = [];
  if (input.hiveSlugs !== undefined) {
    hiveSlugs = input.hiveSlugs.filter((s) => typeof s === 'string' && s.length > 0);
  } else if (harnessSlugs.length > 0) {
    try {
      hiveSlugs = await withTimeout(
        resolveHiveSlugsForHarnesses(input.workspaceId, harnessSlugs),
        'hive-resolve',
      );
    } catch (err) {
      noteMemoryFailure(err);
      hiveSlugs = [];
    }
  }
  if (hiveSlugs.length > MAX_HARNESS_FANOUT) hiveSlugs = hiveSlugs.slice(0, MAX_HARNESS_FANOUT);

  // The store holds only STABLE facts now — user + harness + hive scopes
  // (D-005: the deprecated `workspace:`/`shared` scope is drained, so there is
  // no workspace pull). The backend fans out per scope; `limit` is per-pool,
  // which is exactly the user-pool-vs-pool asymmetry we want.
  let userResults: MemoryEntry[] = [];
  let harnessHits: Array<{ hit: MemoryEntry; slug: string }> = [];
  let hiveHits: Array<{ hit: MemoryEntry; slug: string }> = [];
  try {
    const minScore = injectMinScore();
    const minLexScore = injectMinLexScore();
    const userPull: Promise<MemoryEntry[]> = input.userId
      ? backend.search(input.queryContext, { scope: input.userId, limit: userLimit, minScore, minLexScore })
      : Promise.resolve([]);

    const harnessPull: Promise<MemoryEntry[]> = harnessSlugs.length > 0
      ? backend.search(input.queryContext, {
          scope: harnessSlugs.map((slug) => `harness:${slug}`),
          limit: PER_HARNESS_LIMIT,
          minScore,
          minLexScore,
        })
      : Promise.resolve([]);

    const hivePull: Promise<MemoryEntry[]> = hiveSlugs.length > 0
      ? backend.search(input.queryContext, {
          scope: hiveSlugs.map(hiveScopeKey),
          limit: PER_HARNESS_LIMIT,
          minScore,
          minLexScore,
        })
      : Promise.resolve([]);

    const [userEntries, harnessEntries, hiveEntries] = await withTimeout(
      Promise.all([userPull, harnessPull, hivePull]),
      'search',
    );
    userResults = userEntries;
    harnessHits = harnessEntries.map((hit) => ({
      hit,
      slug: hit.scope.startsWith('harness:') ? hit.scope.slice('harness:'.length) : hit.scope,
    }));
    hiveHits = hiveEntries.map((hit) => ({
      hit,
      slug: hiveSlugFromScope(hit.scope) ?? hit.scope,
    }));
  } catch (err) {
    noteMemoryFailure(err);
    if (!(err instanceof MemoryTimeoutError) && process.env.NODE_ENV !== 'test') {
      console.warn('[memory-injection] search failed:', (err as Error).message);
    }
    return null;
  }

  if (userResults.length + harnessHits.length + hiveHits.length === 0) return null;

  // D-006 — the pre-turn dedup: drop any memory surfaced within the recent
  // watermark window so a stable fact is delivered ONCE, not re-injected
  // turn-over-turn. Best-effort: a query failure returns an empty set (no
  // filtering), so the injection degrades to its prior behavior, never breaks.
  const candidateIds = [
    ...userResults.map((h) => h.id),
    ...harnessHits.map(({ hit }) => hit.id),
    ...hiveHits.map(({ hit }) => hit.id),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  // (ids are always present on neutral entries; the filter guards legacy/odd rows)
  if (candidateIds.length > 0) {
    try {
      const { sql } = getOrgPg();
      const recent = await recentlySurfacedIds(sql, candidateIds, reinjectWindowMs());
      if (recent.size > 0) {
        userResults = userResults.filter((h) => !(h.id && recent.has(h.id)));
        harnessHits = harnessHits.filter(({ hit }) => !(hit.id && recent.has(hit.id)));
        hiveHits = hiveHits.filter(({ hit }) => !(hit.id && recent.has(hit.id)));
      }
    } catch {
      /* swallow — dedup is hygiene, never load-bearing */
    }
  }
  if (userResults.length + harnessHits.length + hiveHits.length === 0) return null;

  const fmtScope = (entry: MemoryEntry, slug?: string): string => {
    const kind = entry.kind ?? 'unknown';
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
  for (const h of userResults) lines.push(`- ${fmtScope(h)}${fmtId(h)} ${h.text}`);
  for (const { hit, slug } of harnessHits) lines.push(`- ${fmtScope(hit, slug)}${fmtId(hit)} ${hit.text}`);
  // Hive pool — labeled `@ hive:<slug>` so an agent can tell shared-Hive
  // knowledge (learnings, conventions) from its harness's own pool.
  for (const { hit, slug } of hiveHits) lines.push(`- ${fmtScope(hit, `hive:${slug}`)}${fmtId(hit)} ${hit.text}`);

  // Phase 5 P-021: stamp last_surfaced_at on every memory we surfaced — this is
  // ALSO the dedup watermark the next turn reads. Fire-and-forget: bumpLastSurfacedSql
  // is fully defensive and its outcome doesn't affect the block we return.
  const surfacedIds: string[] = [];
  for (const h of userResults) if (h.id) surfacedIds.push(h.id);
  for (const { hit } of harnessHits) if (hit.id) surfacedIds.push(hit.id);
  for (const { hit } of hiveHits) if (hit.id) surfacedIds.push(hit.id);
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
