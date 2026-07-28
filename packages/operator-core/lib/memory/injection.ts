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
 * Same shape used by operator-converse today. Designed so other chat
 * routes can adopt the exact same behavior with a 1-line call.
 *
 * Best-effort: any failure (mem0 unavailable, PG down, embedder
 * misconfigured, no hits) returns null and the caller's prompt is
 * unaffected. Never throws.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getMemoryBackend, type MemoryEntry } from './backend';
import { collapseNearDuplicates } from './recall-admission';
import { isMemoryWorkspaceScopedRecallOn, keepUserPoolHitForWorkspace } from './workspace-scope-recall';
import { bumpLastSurfacedSql, recentlySurfacedIds } from './bump-last-surfaced';
import {
  alreadySurfacedIds,
  currentSessionEpoch,
  stampSurfaced,
} from './session-epoch-ledger';
import { hiveScopeKey, hiveSlugFromScope, resolveHiveSlugsForHarnesses } from './hive-scope';
import { memoryTierOf } from './two-tier';
import {
  MEMORY_INJECT_TIMEOUT_MS,
  MemoryTimeoutError,
  isMemoryDegraded,
  noteMemoryFailure,
  withMemoryTimeout,
} from './op-deadline';

// P-016: Mirrors EPHEMERAL_BENCHMARK_SLUG_RE in harness/improvements/watchdog.ts.
// Inlined here to avoid pulling that module's heavy @papercusp/db-org transitive
// imports into injection.ts (which is mocked with a partial db-org stub in tests).
const EPHEMERAL_SLUG_RE =
  /(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|hiveloop|memcap|memrun)|-instance[_-]|_instance[_-]|deleteme|^e2e-imp|^sb-gym|gym-eval|^bench-|smoke-p[0-9]/i;

/**
 * Memory injection is a best-effort enhancement — never load-bearing —
 * and it must never *hang*. `buildOperatorPrompt` awaits this helper
 * inline, so a slow/stuck embedder (e.g. the local BGE ONNX model
 * downloading on first use when no OpenAI key is set) would otherwise
 * block the entire operator turn — the failure mode observed 2026-05-21
 * where operator-converse emitted only SSE heartbeats and never
 * produced a turn.
 *
 * Every store call here is bounded by MEMORY_INJECT_TIMEOUT_MS. The first
 * timeout drops the whole process into a degraded mode so later turns skip
 * the store instantly instead of paying the timeout on every turn. The
 * deadline/latch primitive is shared with the explicit memory tools
 * (./op-deadline, B1) so a hang on EITHER path quiets this hot per-turn path;
 * the latch resets on restart and the backend's poison-cache handles
 * client-level recovery.
 */

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
   * Hive pools to pull (`hive:<slug>` scope — knowledge-packs P-004). Usually
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
  /**
   * WARM-SESSION dedup (memory-delivery-unification-2026-07-12 P-002,
   * D-002/D-006): when set, re-injection is suppressed per SESSION EPOCH
   * (session identity + compaction generation) via the port-agnostic
   * `memory_session_surfaced` ledger, INSTEAD of the chat path's 2-minute
   * wall-clock watermark — an injected fact stays in a warm session's
   * context until compaction, so mid-epoch re-injection is pure waste,
   * while an epoch bump (post-compaction) re-primes everything. Omit on
   * chat paths (watermark behavior unchanged).
   */
  session?: {
    /** Stable per-launch session identity (the su SID / uiClientId). */
    sessionId: string;
    /** Compaction generation; omitted ⇒ resolved from the epoch table. */
    epoch?: number;
    /** Which injection moment this is (initialize/turn-start/compact/brief/claim/create). */
    port?: string;
  };
  /**
   * Per-call assembly budget override (chars). D-004 (memory-delivery-
   * unification): mid-epoch moments (turn-start, the claim/create ports) are
   * high-precision/LOW-VOLUME — injected lines compound in a warm session —
   * so they pass a small budget (~3-4k) instead of the global 16k default.
   */
  budgetChars?: number;
  /**
   * P-005 telemetry override: the recall-stats `surface` label for this call,
   * for a port that has NO dedup session to carry `session.port` — the Mug/cup
   * brief ('brief'), whose long-lived loop must NOT permanently dedup (no
   * compaction epoch to reset it). When set it wins over `session?.port`;
   * otherwise the surface is `session?.port ?? 'injection'`. Telemetry only —
   * never affects recall/dedup.
   */
  telemetrySurface?: string;
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
/**
 * The production PUSH-path floors (LOCKED by the P-031 2D sweep, D-006). Exported
 * so the memory-precision-bench monitor (relight P-033) measures at the EXACT
 * production floor — a single source of truth, not a copied magic number. The
 * `injectMin*` readers below default to these (env-overridable).
 */
export const MEMORY_INJECTION_COSINE_FLOOR = 0.45;
export const MEMORY_INJECTION_LEX_FLOOR = 0.4;

function injectMinScore(): number | undefined {
  const raw = Number(process.env.PAPERCUSP_MEMORY_MIN_SCORE);
  if (Number.isFinite(raw)) return raw > 0 ? raw : undefined;
  return MEMORY_INJECTION_COSINE_FLOOR;
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
  return MEMORY_INJECTION_LEX_FLOOR;
}

/**
 * PUSH-path fusion mode (context-injection-audit-2026-07-28 P-032 / F-B, D-010).
 * THE fix that makes the injected block sized by relevance instead of by K.
 *
 * The hybrid default is `floored-union`, where the lexical leg admits hits on
 * `minLexScore` ALONE — independently of the cosine leg's FP floor — and the
 * fusion then returns `slice(0, limit)`. So the cosine leg could return ZERO and
 * the block still came back FULL, refilled by lexical token-overlap: measured at
 * 97% of turn-start recalls returning exactly the pool-limit sums (D-005), with a
 * 0.0% zero-hit rate. The limit was acting as a TARGET, not a ceiling.
 *
 * Note what was NOT the problem, because it is the natural thing to reach for and
 * it does not work (D-008): the 0.45 cosine floor was firing correctly the whole
 * time. Raising it removes cosine hits and the lexical leg simply back-fills the
 * freed slots — less relevance, same K. The size is decided by ADMISSION, so
 * admission is what has to change.
 *
 * Under `cosine-gated` the candidate set is seeded ONLY from cosine hits
 * (hybrid-fusion.ts) — lexical-only admission is skipped — so membership is
 * governed by the cosine floor and the result is naturally 0..K. A real ceiling.
 * The lexical leg still contributes its RANK to the fused score, so exact-id
 * matches keep re-ranking cosine hits to the top; what is given up is a
 * lexical-only hit the cosine leg missed entirely.
 *
 * PUSH ONLY — deliberately not set on the HybridBackend construction
 * (configure.ts), so the PULL path keeps `floored-union`. A human running
 * memory:search wants recall and can discard a bad hit; auto-injection has no
 * LLM filter downstream, so it wants precision. Same asymmetry that already
 * justifies the push path's tighter minLexScore above. Env-tunable for a
 * one-flip revert if the zero-hit rate overshoots.
 */
function injectFusionMode(): 'floored-union' | 'cosine-gated' {
  return process.env.PAPERCUSP_MEMORY_FUSION_MODE === 'floored-union'
    ? 'floored-union'
    : 'cosine-gated';
}

/**
 * Injected-block character budget (knowledge-packs P-011 / D-008). ~4k tokens
 * by default (≈4 chars/token). Lines are admitted in priority order — user
 * pool → harness pools → hive-organic → hive-pack — and assembly stops at the
 * budget, so a hive carrying many packs can't crowd the user's own facts out
 * of the turn. Env-tunable; `<= 0` disables the cap.
 */
function injectBudgetChars(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS);
  if (Number.isFinite(raw)) return raw > 0 ? raw : Number.POSITIVE_INFINITY;
  return 16_000;
}

/**
 * Phase telemetry (EI-12962): the injection measured ~10.7s of a ~11s prompt
 * build on a COLD operator process (available() ~5s + first-embed ~4s) vs
 * ~1.5s warm (probe 2026-07-16, hybrid-pg, 7-scope fan-out). Log the per-phase
 * split whenever a call is slow enough to matter, so a cold-start regression
 * (or a warmup that stopped covering the real path) is visible in the operator
 * log instead of re-derived by hand. `postMs` = totalMs − the stamped legs
 * (feedback/dedup/flags/assembly).
 */
const SLOW_INJECTION_LOG_MS = 750;

export async function buildMemoryContextBlock(
  input: MemoryInjectionInput,
): Promise<string | null> {
  const marks: Array<[string, number]> = [];
  const t0 = Date.now();
  try {
    return await buildBlockInner(input, (label, ms) => marks.push([label, ms]));
  } finally {
    const totalMs = Date.now() - t0;
    if (totalMs > SLOW_INJECTION_LOG_MS) {
      const stamped = marks.reduce((s, [, v]) => s + v, 0);
      console.log(
        `[memory-injection] phases totalMs=${totalMs} ${marks
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')} postMs=${Math.max(0, totalMs - stamped)}`,
      );
    }
  }
}

async function buildBlockInner(
  input: MemoryInjectionInput,
  mark: (label: string, ms: number) => void,
): Promise<string | null> {
  if (!input.queryContext.trim()) return null;
  if (isMemoryDegraded()) return null;

  const backend = getMemoryBackend();
  const tAvail = Date.now();
  try {
    const avail = await withMemoryTimeout(backend.available(), 'available()', MEMORY_INJECT_TIMEOUT_MS);
    if (!avail.ok) return null;
  } catch (err) {
    noteMemoryFailure(err);
    return null;
  } finally {
    mark('availableMs', Date.now() - tAvail);
  }

  const userLimit = input.limit ?? 6;

  // P-016: exclude ephemeral/benchmark harness scopes from production recall
  // injection so benchmark memories don't pollute the pre-turn prompt.
  let harnessSlugs = (input.harnessSlugs ?? [])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .filter((s) => !EPHEMERAL_SLUG_RE.test(s));
  if (harnessSlugs.length > MAX_HARNESS_FANOUT) {
    console.warn(
      `[memory-injection] harnessSlugs (${harnessSlugs.length}) exceeds MAX_HARNESS_FANOUT (${MAX_HARNESS_FANOUT}); slicing.`,
    );
    harnessSlugs = harnessSlugs.slice(0, MAX_HARNESS_FANOUT);
  }

  // Hive pools (knowledge-packs P-004): resolve the owning hives from the
  // harness slugs unless the caller pinned them. Best-effort — a registry
  // hiccup degrades to "no hive pull", never blocks the turn.
  let hiveSlugs: string[] = [];
  if (input.hiveSlugs !== undefined) {
    hiveSlugs = input.hiveSlugs.filter((s) => typeof s === 'string' && s.length > 0);
  } else if (harnessSlugs.length > 0) {
    const tHive = Date.now();
    try {
      hiveSlugs = await withMemoryTimeout(
        resolveHiveSlugsForHarnesses(input.workspaceId, harnessSlugs),
        'hive-resolve',
        MEMORY_INJECT_TIMEOUT_MS,
      );
    } catch (err) {
      noteMemoryFailure(err);
      hiveSlugs = [];
    } finally {
      mark('hiveResolveMs', Date.now() - tHive);
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
    // F-B (D-010): the limit is a CEILING on this path, not a target.
    const fusionMode = injectFusionMode();

    const tSearch = Date.now();
    let sharedEmbedMs = 0;
    const pullTimes: Record<string, number> = {};
    const timed = async (label: string, p: Promise<MemoryEntry[]>): Promise<MemoryEntry[]> => {
      const t = Date.now();
      try {
        return await p;
      } finally {
        pullTimes[label] = Date.now() - t;
      }
    };

    // EI-12992: embed+3-pulls run as ONE region under the SAME MEMORY_INJECT_TIMEOUT_MS
    // budget below (never a second, stacked timeout) — the shared embed just replaces
    // part of what each pull used to spend its OWN slice of that same budget on.
    const doSearch = async (): Promise<[MemoryEntry[], MemoryEntry[], MemoryEntry[]]> => {
      // EI-12992: embed the query ONCE (best-effort) and share it across the harness +
      // hive pulls via `SearchOptions.vector` — both already forgo mem0's entity-graph
      // boost through the EI-12962 batched multi-scope path regardless of who embeds
      // (see mem0-backend.ts), so sharing the vector there costs zero precision. 3
      // independent per-pull embeds (~0.5-1s each) were riding right up against
      // MEMORY_INJECT_TIMEOUT_MS (measured live: searchMs within ~10% of the 5s
      // timeout) — this collapses up to 3 embeds into 1.
      //
      // The USER pool deliberately keeps its OWN per-call embed (never passed the
      // shared vector): it's the highest-priority pool (userLimit=6 vs
      // PER_HARNESS_LIMIT=3) and the ONLY one still entity-boosted today; trading
      // that precision for speed was out of scope for this fix.
      //
      // `embedQuery` is an OPTIONAL backend capability (feature-tested) — a backend
      // without it, or a failed/null embed, leaves `sharedVector` null and every
      // pull embeds independently, exactly as before this fix (fully backward
      // compatible; never a hard failure).
      let sharedVector: number[] | null = null;
      if ((harnessSlugs.length > 0 || hiveSlugs.length > 0) && backend.embedQuery) {
        const tEmbed = Date.now();
        try {
          sharedVector = await backend.embedQuery(input.queryContext);
        } catch (err) {
          noteMemoryFailure(err);
        } finally {
          sharedEmbedMs = Date.now() - tEmbed;
        }
      }

      const userPull: Promise<MemoryEntry[]> = input.userId
        ? timed('user', backend.search(input.queryContext, { scope: input.userId, limit: userLimit, minScore, minLexScore, fusionMode }))
        : Promise.resolve([]);

      const harnessPull: Promise<MemoryEntry[]> = harnessSlugs.length > 0
        ? timed('harness', backend.search(input.queryContext, {
            scope: harnessSlugs.map((slug) => `harness:${slug}`),
            limit: PER_HARNESS_LIMIT,
            minScore,
            minLexScore,
            fusionMode,
            ...(sharedVector ? { vector: sharedVector } : {}),
          }))
        : Promise.resolve([]);

      const hivePull: Promise<MemoryEntry[]> = hiveSlugs.length > 0
        ? timed('hive', backend.search(input.queryContext, {
            scope: hiveSlugs.map(hiveScopeKey),
            limit: PER_HARNESS_LIMIT,
            minScore,
            minLexScore,
            fusionMode,
            ...(sharedVector ? { vector: sharedVector } : {}),
          }))
        : Promise.resolve([]);

      return Promise.all([userPull, harnessPull, hivePull]);
    };

    const [userEntries, harnessEntries, hiveEntries] = await withMemoryTimeout(
      doSearch(),
      'search',
      MEMORY_INJECT_TIMEOUT_MS,
    ).finally(() => {
      const searchMs = Date.now() - tSearch;
      mark('searchMs', searchMs);
      // EI-12992 lever 2: per-pull + shared-embed breakdown — a SEPARATE line from
      // the `marks` phase-sum (searchMs already covers this whole CONCURRENT block;
      // folding these overlapping sub-legs into `marks` too would double-count and
      // corrupt the existing postMs = totalMs − stamped-legs invariant). Only when
      // the search phase itself was slow enough to be worth reading.
      if (searchMs > SLOW_INJECTION_LOG_MS) {
        console.log(
          `[memory-injection] search-detail sharedEmbedMs=${sharedEmbedMs} ` +
            Object.entries(pullTimes)
              .map(([k, v]) => `${k}Ms=${v}`)
              .join(' '),
        );
      }
    });
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

  // Recall telemetry (EI-366 / migration 240): record what the index returned
  // for this turn — zero hits INCLUDED (the zero-hit-rate is the signal) —
  // before any policy filtering below. Fire-and-forget.
  //
  // P-026 / migration 703: record it PER POOL. This block is the only place the
  // three pools still exist separately — everything downstream is concatenated —
  // so a flat hit_count recorded here is information destroyed at the one point
  // it was still available. hit_count=6 cannot distinguish "6 user + 0 harness"
  // from "3 user + 3 harness", which is precisely how a harness pool that
  // returned zero on every call (orphaned by an unmigrated slug rename) hid
  // behind a surface reporting a 0.0% zero-hit rate. Each pool also carries the
  // budget and the scope keys IN EFFECT FOR THIS CALL, so saturation stays
  // computable after the constants are retuned and a pool queried under a slug
  // nothing writes to is distinguishable from a pool with nothing relevant.
  {
    const userScopes = input.userId ? [input.userId] : [];
    const harnessScopes = harnessSlugs.map((slug) => `harness:${slug}`);
    const hiveScopes = hiveSlugs.map(hiveScopeKey);
    void (async () => {
      try {
        const { sql } = getOrgPg();
        const { recordRecallStats } = await import('./recall-stats');
        // P-005: tag the recall with its injection PORT so per-entry-point
        // recall quality is measurable separately. session.port carries the
        // port for every launch/injection surface (initialize / compact /
        // turn-start / claim / create / orient / brief); an unstamped generic
        // injection falls back to 'injection'.
        await recordRecallStats(sql, {
          surface: input.telemetrySurface ?? input.session?.port ?? 'injection',
          workspaceId: input.workspaceId ?? null,
          potSlug: harnessSlugs[0] ?? null,
          pools: {
            user: { entries: userResults, limit: userLimit, scopes: userScopes },
            harness: {
              entries: harnessHits.map(({ hit }) => hit),
              limit: PER_HARNESS_LIMIT,
              scopes: harnessScopes,
            },
            hive: {
              entries: hiveHits.map(({ hit }) => hit),
              limit: PER_HARNESS_LIMIT,
              scopes: hiveScopes,
            },
          },
        });
      } catch {
        /* swallow — telemetry never blocks a turn */
      }
    })();
  }

  if (userResults.length + harnessHits.length + hiveHits.length === 0) return null;

  // knowledge-packs P-009: a DISABLED pack's rows stay stored but stop being
  // recalled. One settings read per hive in scope (usually 1); best-effort —
  // a settings hiccup means no filtering, never a blocked turn.
  if (hiveHits.length > 0) {
    try {
      const { disabledPacksFor } = await import('../knowledge-packs/manage');
      const slugs = [...new Set(hiveHits.map(({ slug }) => slug))];
      const disabledBySlug = new Map(
        await Promise.all(
          slugs.map(async (slug) => [slug, new Set(await disabledPacksFor(input.workspaceId, slug))] as const),
        ),
      );
      hiveHits = hiveHits.filter(({ hit, slug }) => {
        const m = hit.metadata ?? {};
        const packId = m.source === 'pack' && typeof m.pack_id === 'string' ? m.pack_id : undefined;
        return !(packId && disabledBySlug.get(slug)?.has(packId));
      });
    } catch {
      /* best-effort — never load-bearing */
    }
  }
  if (userResults.length + harnessHits.length + hiveHits.length === 0) return null;

  // memory_feedback consumer (EI-366 / consume-edges P-031): the push path
  // DROPS anything the user deleted — tombstoned ids (the lexical projection
  // has no per-delete reconciliation, so deleted facts can ghost back through
  // that leg) and re-extractions of deleted content. Injecting content the
  // user deleted is worse than a missed recall; memory:search still finds it
  // on demand (demoted, not hidden). Best-effort like the dedup below.
  try {
    const { sql } = getOrgPg();
    const { loadFeedbackSignals, isFeedbackSuppressed } = await import('./feedback-rerank');
    const signals = await loadFeedbackSignals(sql);
    if (signals.deletedIds.size > 0 || signals.deletedTexts.size > 0) {
      userResults = userResults.filter((h) => !isFeedbackSuppressed(h, signals));
      harnessHits = harnessHits.filter(({ hit }) => !isFeedbackSuppressed(hit, signals));
      hiveHits = hiveHits.filter(({ hit }) => !isFeedbackSuppressed(hit, signals));
    }
  } catch {
    /* hygiene, never load-bearing */
  }

  // data-scoping-audit P-006 / D-004 / D-012 (dark cutover): workspace-scope the per-owner
  // USER pool — drop a `project` hit explicitly tagged with a DIFFERENT workspace; keep
  // owner-tier (user/feedback/reference) + legacy NULL-workspace rows. The harness/hive
  // pools are already correctly scoped. Conservative + NULL-safe; OFF = today's behavior.
  if (userResults.length > 0 && (await isMemoryWorkspaceScopedRecallOn())) {
    userResults = userResults.filter((h) => keepUserPoolHitForWorkspace(h, input.workspaceId));
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
  // P-002: a warm session (input.session) dedups against its session-epoch
  // ledger; the chat path keeps the wall-clock watermark. Same best-effort
  // posture either way: a failed read = no filtering, never a broken inject.
  let sessionEpoch: number | null = null;
  if (candidateIds.length > 0) {
    try {
      const { sql } = getOrgPg();
      let suppressed: Set<string>;
      if (input.session?.sessionId) {
        sessionEpoch =
          input.session.epoch ?? (await currentSessionEpoch(sql, input.session.sessionId));
        suppressed = await alreadySurfacedIds(
          sql,
          input.session.sessionId,
          sessionEpoch,
          candidateIds,
        );
      } else {
        suppressed = await recentlySurfacedIds(sql, candidateIds, reinjectWindowMs());
      }
      if (suppressed.size > 0) {
        userResults = userResults.filter((h) => !(h.id && suppressed.has(h.id)));
        harnessHits = harnessHits.filter(({ hit }) => !(hit.id && suppressed.has(hit.id)));
        hiveHits = hiveHits.filter(({ hit }) => !(hit.id && suppressed.has(hit.id)));
      }
    } catch {
      /* swallow — dedup is hygiene, never load-bearing */
    }
  }
  if (userResults.length + harnessHits.length + hiveHits.length === 0) return null;

  // Two-tier marker (self-learning-frontier P-022 / FB-08, D-006): with the
  // transfer harness armed, probationary entries are visibly marked — STILL
  // injected (admission is free); the marker just shows the trust level until
  // a student-transfer test promotes them. Flag dark (the D-001 default) ⇒
  // byte-identical output. Best-effort: a flags hiccup means no markers.
  let tierMarkers = false;
  try {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    tierMarkers = await getFlag(FLAGS.TRANSFER_HARNESS, 'memory-injection');
  } catch {
    /* never load-bearing */
  }

  const fmtScope = (entry: MemoryEntry, slug?: string): string => {
    const kind = entry.kind ?? 'unknown';
    const tier = tierMarkers && memoryTierOf(entry) === 'probationary' ? ' · probationary' : '';
    if (slug) return `[${kind}${tier} @ ${slug}]`;
    return `[${kind}${tier}]`;
  };

  // Phase 5 P-020: surface memory_id alongside each entry so the agent
  // can call memory:forget when a user correction contradicts an
  // injected memory. Suffix-style to keep the existing `[kind] <text>`
  // format backward-compatible.
  const fmtId = (h: { id?: string }): string =>
    typeof h.id === 'string' && h.id ? ` (id=${h.id})` : '';

  // Assembly under the P-011 budget, in priority order (D-008): the user's own
  // facts → harness pools → hive-organic (recorded conventions) → hive-pack
  // (seeded learnings). Pack rows are the most numerous and least
  // turn-specific, so they yield first when the block would overflow.
  const isPackHit = (hit: MemoryEntry): boolean =>
    hit.metadata?.source === 'pack' && typeof hit.metadata?.pack_id === 'string';
  const hiveOrganic = hiveHits.filter(({ hit }) => !isPackHit(hit));
  const hivePack = hiveHits.filter(({ hit }) => isPackHit(hit));

  const budget =
    input.budgetChars && input.budgetChars > 0 ? input.budgetChars : injectBudgetChars();
  let spent = 0;
  const lines: string[] = [];
  const surfacedIds: string[] = [];
  const admit = (line: string, id?: string): boolean => {
    if (spent + line.length > budget && lines.length > 0) return false;
    lines.push(line);
    spent += line.length;
    if (id) surfacedIds.push(id);
    return true;
  };
  // Priority-ordered render: user's own facts → harness pools → hive-organic → hive-pack.
  const rendered = [
    ...userResults.map((h) => ({ line: `- ${fmtScope(h)}${fmtId(h)} ${h.text}`, id: h.id, text: h.text ?? '' })),
    ...harnessHits.map(({ hit, slug }) => ({ line: `- ${fmtScope(hit, slug)}${fmtId(hit)} ${hit.text}`, id: hit.id, text: hit.text ?? '' })),
    // Hive pool — labeled `@ hive:<slug>` so an agent can tell shared-Hive
    // knowledge (learnings, conventions) from its harness's own pool.
    ...hiveOrganic.map(({ hit, slug }) => ({ line: `- ${fmtScope(hit, `hive:${slug}`)}${fmtId(hit)} ${hit.text}`, id: hit.id, text: hit.text ?? '' })),
    ...hivePack.map(({ hit, slug }) => ({ line: `- ${fmtScope(hit, `hive:${slug}`)}${fmtId(hit)} ${hit.text}`, id: hit.id, text: hit.text ?? '' })),
  ];
  // P-008 (WI-4538): collapse near-duplicate memories (the SAME fact stored under multiple ids
  // — the id-based dedups above can't see it) BEFORE the budget, so a dupe never consumes a
  // slot a distinct fact needed. Priority order is preserved, so the highest-priority copy of
  // each cluster survives.
  const { kept: dedupedRendered } = collapseNearDuplicates(rendered, (r) => r.text);
  let truncated = false;
  for (const { line, id } of dedupedRendered) {
    if (!admit(line, id)) {
      truncated = true;
      break;
    }
  }
  if (lines.length === 0) return null;
  if (truncated) {
    lines.push('- (more learnings withheld this turn — the memory budget is full; memory:search pulls the rest on demand)');
  }

  // Phase 5 P-021: stamp last_surfaced_at on every memory we surfaced — this is
  // ALSO the dedup watermark the next turn reads. Fire-and-forget: bumpLastSurfacedSql
  // is fully defensive and its outcome doesn't affect the block we return.
  // (Only ACTUALLY-injected ids are stamped — a budget-dropped memory must not
  // be dedup-suppressed next turn.)
  if (surfacedIds.length > 0) {
    const session = input.session;
    const epochForStamp = sessionEpoch;
    void (async () => {
      try {
        const { sql } = getOrgPg();
        // last_surfaced_at stays stamped for EVERY path — it feeds the
        // Layer-3 "recently used" pickers, not just the chat dedup.
        await bumpLastSurfacedSql(sql, surfacedIds);
        // P-002: warm sessions ALSO stamp the port-agnostic epoch ledger so
        // every later injection moment of this epoch dedups against it.
        if (session?.sessionId) {
          await stampSurfaced(
            sql,
            session.sessionId,
            epochForStamp ?? (await currentSessionEpoch(sql, session.sessionId)),
            surfacedIds,
            session.port ?? 'injection',
          );
        }
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
