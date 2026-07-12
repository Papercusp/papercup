/**
 * memory:search — semantic recall over the user's persistent memories.
 *
 * The route's pre-turn injection auto-surfaces relevant memories every
 * turn; brain only needs to call this for targeted lookup ("did I tell
 * you about X?"). Searches user-scoped + harness-scoped (current
 * harness if `harness_slug` is passed, every harness in the workspace
 * otherwise). The deprecated workspace-shared pool was drained (D-005).
 *
 * Storage rides the neutral `MemoryBackend` seam; per-scope fan-out and
 * merge live behind it. RESPONSE CONTRACT (byte-stable — the TUI Memory
 * tab consumes it): { ok, reason?, results: [{ id, memory, metadata,
 * score }] }. Additive degraded stamps (EI-9031 / WI-4214): any failed or
 * reduced-fidelity recall carries `degraded: true` (+ `degraded_reason`,
 * and `fallback: 'lexical'` when the hits came from the embed-free
 * token-match fallback) so an empty/thin result is never mistaken for an
 * informative "nothing relevant exists".
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend, MemoryUnavailableError, type MemoryEntry } from '../../memory/backend';
import { isMemoryWorkspaceScopedRecallOn, keepUserPoolHitForWorkspace } from '../../memory/workspace-scope-recall';
import {
  MemoryTimeoutError,
  withMemoryToolTimeout,
  withMemoryTimeout,
  memoryLexicalFallbackTimeoutMs,
  embedFailureReason,
} from '../../memory/op-deadline';
import { isOpenAiEmbedInCooldown } from '../../memory/configure';
import { getSessionUserOrDefault } from '../../auth';
import { loadHarnessRegistry } from '../../harness-registry';
import { isEphemeralBenchmarkHarnessSlug } from '../../harness/improvements/watchdog';
import { narrowHarnessSlugsToSessionHive } from '../../memory/hive-scope';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../../flag-distinct-id';

/**
 * Per-session-tier hit shaping (context-trimming-tiers P-024). This tool's
 * response is a BYTE-STABLE contract (the TUI Memory tab reads content[0].text
 * over a non-mcp transport), so it keeps the hand-rolled ToolResult and adapts
 * IN-HANDLER off ctx.contextTier — the coord:inbox precedent — instead of
 * declaring `shape`. No-tier callers (the TUI, hooks) get full, byte-identical
 * rows; a trimmed/standard LLM session gets each hit's text clipped (loud:
 * memory_truncated + memory_full_chars per row, payload_tier at the top) and,
 * at trimmed, metadata reduced to its `kind`. payloadTier:"full" per call
 * restores everything (the dispatch overlay threads it into ctx.contextTier).
 */
export const MEMORY_SEARCH_TIER_CAPS = {
  trimmed: { text: 280, metadataKindOnly: true },
  standard: { text: 500, metadataKindOnly: false },
} as const;

export function shapeMemoryHit(
  row: { id: string; memory: string; metadata?: Record<string, unknown>; score?: number },
  tier: keyof typeof MEMORY_SEARCH_TIER_CAPS,
): Record<string, unknown> {
  const c = MEMORY_SEARCH_TIER_CAPS[tier];
  const clipped = row.memory.length > c.text;
  const metadata = c.metadataKindOnly
    ? row.metadata?.kind !== undefined
      ? { kind: row.metadata.kind }
      : undefined
    : row.metadata;
  return {
    id: row.id,
    memory: clipped ? `${row.memory.slice(0, c.text - 1)}…` : row.memory,
    ...(clipped ? { memory_truncated: true, memory_full_chars: row.memory.length } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(row.score !== undefined ? { score: row.score } : {}),
  };
}

/** Map a neutral entry onto the stable wire row the surfaces consume.
 *  `kind` is materialized into `metadata.kind` — the TUI Memory tab reads
 *  it there, and non-mem0 backends (e.g. claude-file) carry kind only at
 *  the entry level. For mem0 rows this is a no-op (kind already matches). */
export function toWireRow(e: MemoryEntry): {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  score?: number;
} {
  const metadata = e.kind !== undefined
    ? { ...(e.metadata ?? {}), kind: e.kind }
    : e.metadata;
  return {
    id: e.id,
    memory: e.text,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(e.score !== undefined ? { score: e.score } : {}),
  };
}

export default defineTool({
  name: 'memory:search',
  capability: 'memory:read',
  description:
    'Search the user\'s persistent memories by semantic similarity. Returns matched facts ranked by relevance.',
  guidance: {
    when:
      'When the user references specific context from past sessions ("what did I tell you about pricing?"). Pre-turn auto-injection covers most cases; only call this for targeted lookups.',
    notWhen:
      'For lookups by exact metadata (kind), use memory:list — it\'s faster than vector search for filter-only queries.',
    chaining:
      'Pair with memory:update / memory:forget when the user corrects something you recall.',
    seeAlso: [
      'memory:remember (write a new durable fact)',
      'memory:list (filter-only lookup by exact metadata — faster than vector search)',
      'memory:forget (drop a recalled hit the user contradicted)',
    ],
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so memory:search works from a psu
  // session instead of failing `workspace_required`. (EI: memory unreachable from psu.)
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
    harness_slug: z.string().optional()
      .describe('Scope the search to a single harness in addition to user memory. Omit to fan out across every harness in the workspace.'),
    harnessOnly: z.boolean().optional()
      .describe('Scope to ONLY the named harness pool — EXCLUDE the user/personal pool. For ISOLATED per-run pools (e.g. a benchmark capability-injection arm) where the user\'s personal memories would be noise. Requires harness_slug; ignored without it.'),
    workspace: z.string().optional()
      .describe('Superuser-only: from an UNSCOPED session, resolve harness fan-out within THIS workspace (the resolved workspace scopes the fan-out). Scoped/power-user sessions ignore it. Omit for personal (user-scoped) recall.'),
    as_of: z.string().max(64)
      .refine((v) => Number.isFinite(new Date(v).getTime()), 'as_of must be a parseable ISO 8601 timestamp')
      .optional()
      .describe('TEMPORAL (temporal-lite): point-in-time recall — only memories whose validity window covers this ISO timestamp ("what did we believe then?"). Hits carry metadata.validity.'),
    include_superseded: z.boolean().optional()
      .describe('TEMPORAL (temporal-lite): include superseded/soft-forgotten memories (validity window closed) — excluded from recall by default. Superseded hits carry metadata.validity { status:"superseded", superseded_by }.'),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const limit = args.limit ?? 8;

    // Scope resolution — registry/flag reads only, never a memory-backend
    // call, so it sits AHEAD of the deadline-guarded region: the degraded
    // lexical fallback below needs the SAME scopes after the semantic leg
    // has already failed (WI-4214).
    let harnessSlugs: string[];
    if (args.harness_slug) {
      harnessSlugs = [args.harness_slug];
    } else {
      try {
        // The principal carries the resolved workspace (incl. a per-call
        // `workspace` pin from an unscoped SU session); the old
        // `ctx.workspaceId` read was never populated on principal-gated
        // handlers, so the fan-out silently degraded to user-pool-only (P-004).
        const reg = await loadHarnessRegistry(ctx.principal?.workspaceId ?? '');
        // P-016: exclude ephemeral/benchmark harness scopes from unscoped
        // production recall so benchmark memories don't pollute results.
        // Explicit harness_slug (above) bypasses this filter intentionally.
        harnessSlugs = reg.projects
          .map((p) => p.slug)
          .filter((s) => !isEphemeralBenchmarkHarnessSlug(s));
        // P-018 (scoped-superuser-workspace-clamp / D-009 P-016b): confine the
        // DEFAULT fan-out to the session's hive subtree so a hive-confined
        // session (concrete `ctx.harnessSlug` — a bee or a hive-scoped su) does
        // NOT recall SIBLING hives' harness pools — a cross-hive recall bleed,
        // live now that the workspace runs multiple hives. A workspace/unscoped
        // session (harness '*') is left untouched (the workspace-scoped Queen
        // recalls across its hives). Gated by the clamp flag (rides its rollout;
        // a kill-switch). Fail-OPEN — a flag-read error keeps the full fan-out,
        // matching the clamp's fail-open-on-infra-error posture (no recall loss
        // on a flag hiccup; the worst case is over-broad recall, never a leak).
        try {
          if (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, systemDistinctId())) {
            harnessSlugs = narrowHarnessSlugsToSessionHive(reg.projects, harnessSlugs, ctx.harnessSlug);
          }
        } catch {
          /* fail-open: keep the full workspace fan-out */
        }
      } catch {
        harnessSlugs = [];
      }
    }

    // Scope: user-pool + harness-pool(s) normally. With harnessOnly (+ a harness_slug), scope to ONLY the
    // harness pool — drop the user pool — so an ISOLATED per-run pool (a benchmark capability-injection arm)
    // recalls just its own facts, not the user's personal memories (which would be noise / confound the
    // measurement). harnessOnly without harness_slug is meaningless (no pool to isolate to) → ignored.
    const harnessScopes = harnessSlugs.map((slug) => `harness:${slug}`);
    const scope = args.harnessOnly && args.harness_slug ? harnessScopes : [user.id, ...harnessScopes];

    // Temporal-lite read controls (P-006) — ride SearchOptions into the backend
    // (and the lexical fallback below, so a degraded point-in-time read keeps
    // its time semantics).
    const temporal = {
      ...(args.as_of !== undefined ? { asOf: args.as_of } : {}),
      ...(args.include_superseded ? { includeSuperseded: true } : {}),
    };

    // B1 (infra-fail-fast-build-integrity-2026-06-19): bound EVERY backend call
    // with a deadline. `available()` itself can hang when the store is wedged
    // (the 2026-06-19 outage), so it is inside the guarded region too. A timeout
    // returns the same `{ ok:false, reason, results:[] }` envelope as a clean
    // "store down" probe — but with `memory_timeout` — instead of an infinite hang.
    let hits: MemoryEntry[];
    // WI-4214 (P-005 memory-public-release-hardening): set when the SEMANTIC leg
    // failed but the embed-free lexical fallback served the hits — the envelope
    // is stamped degraded + fallback:'lexical' so callers know these are token
    // matches (paraphrase recall is out), never a full-fidelity result.
    let overloadDegradedReason: string | null = null;
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:search available');
      if (!avail.ok) {
        // A down store is a DEGRADED recall, not an informative empty (same
        // EI-9031 posture as the embed-failure branch below).
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason, degraded: true, results: [] }) }],
        };
      }
      // The backend fans out per scope (limit applies per pool), merges,
      // de-dupes by id and sorts by score; we apply the global cap here.
      hits = await withMemoryToolTimeout(
        backend.search(args.query, { scope, limit, ...temporal }),
        'memory:search search',
      );
    } catch (err) {
      // Classify the failure to a CLEAN reason (mem0-timeout-fix-2026-06-24 /
      // EI-9031 / WI-4183): a hang → memory_timeout; a clean store-down probe
      // mid-flight → its own reason (previously an opaque handler_error); an
      // embed failure (429/5xx/stall/sidecar) → its classified reason.
      const reason =
        err instanceof MemoryTimeoutError
          ? 'memory_timeout'
          : err instanceof MemoryUnavailableError
            ? err.reason
            : embedFailureReason(err);
      if (!reason) throw err;
      // WI-4214: the semantic leg is unusable (saturated/overloaded embedder,
      // or an embed-path failure) but the store itself may be fine — attempt
      // the EMBED-FREE lexical fallback under its own short deadline before
      // giving up. Feature-tested: a backend without the capability (or a
      // fallback that itself fails/times out) degrades to the honest empty
      // envelope below, exactly as before.
      const lexical = backend.searchLexical?.bind(backend);
      let fallbackHits: MemoryEntry[] | null = null;
      if (lexical) {
        try {
          fallbackHits = await withMemoryTimeout(
            lexical(args.query, { scope, limit, ...temporal }),
            'memory:search lexical fallback',
            memoryLexicalFallbackTimeoutMs(),
          );
        } catch {
          fallbackHits = null;
        }
      }
      if (fallbackHits === null) {
        // EI-9031: a failed recall is a DEGRADED recall, not an informative
        // empty — stamp it loudly (in addition to the reason) so agents /
        // orient never read the `[]` as "nothing relevant exists".
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason, degraded: true, results: [] }) }],
        };
      }
      // Lexical hits ride the NORMAL post-processing below (workspace-scope
      // filter, feedback rerank, tier shaping) — degraded recall still honors
      // every hygiene/scoping invariant of the healthy path.
      hits = fallbackHits;
      overloadDegradedReason = reason;
    }

    // data-scoping-audit P-006 / D-004 / D-012 (dark cutover): workspace-scope the USER
    // pool — drop `project` hits tagged with a different workspace; keep owner-tier +
    // legacy NULL-workspace. harness pools (scope `harness:*`) pass through untouched.
    if (await isMemoryWorkspaceScopedRecallOn()) {
      const activeWs = ctx.principal?.workspaceId;
      hits = hits.filter((h) => h.scope !== user.id || keepUserPoolHitForWorkspace(h, activeWs));
    }

    // memory_feedback consumer (EI-366 / consume-edges P-031): drop hits the
    // user deleted (tombstones — the lexical projection has no per-delete
    // reconciliation) and demote re-extractions of deleted content. Hygiene,
    // never load-bearing — any failure skips the pass.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { loadFeedbackSignals, applyFeedbackRerank } = await import('../../memory/feedback-rerank');
      hits = applyFeedbackRerank(hits, await loadFeedbackSignals(getOrgPg().sql));
    } catch { /* best-effort */ }

    // EI-9031: when the production embedder (OpenAI) is in its post-exhaustion
    // cooldown, the 'auto' cascade has silently fallen back to the local vec table
    // — older OpenAI-embedded memories live in a DIFFERENT per-mode table, so an
    // empty/short result in this window is NOT reliably "nothing relevant exists".
    // Stamp the recall `degraded` so agents (and coord:orient, which folds this)
    // don't treat a possibly-false MISS as informative context. A recall hit is
    // binding — the dual is that a recall miss informs decisions too, and a fake
    // miss corrupts that inference for every agent for the whole outage.
    const embeddingDegraded = isOpenAiEmbedInCooldown();

    const wireRows = hits.slice(0, limit).map(toWireRow);
    // Session-tier hit shaping (P-024) — see MEMORY_SEARCH_TIER_CAPS above.
    // No-tier callers (the TUI Memory tab, hooks) take the full branch.
    const sessionTier = (ctx as { contextTier?: 'trimmed' | 'standard' | 'full' }).contextTier;
    const results =
      sessionTier === 'trimmed' || sessionTier === 'standard'
        ? wireRows.map((r) => shapeMemoryHit(r, sessionTier))
        : wireRows;

    // Result count into tool_invocations.metadata_json (mirrors plans:search):
    // the negative-space miner (self-learning-frontier P-010) detects zero-hit
    // searches by `metadata_json->>'count'`; the query rides in args_json.
    (ctx as { metadata?: (d: Record<string, unknown>) => void }).metadata?.({ count: results.length });

    // Recall telemetry (migration 240) — zero-hit-rate + score distribution
    // for the Learning tab memory-health card. Fire-and-forget.
    void (async () => {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { recordRecallStats } = await import('../../memory/recall-stats');
        await recordRecallStats(getOrgPg().sql, { surface: 'search', entries: hits });
      } catch { /* swallow — telemetry never fails a recall */ }
    })();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            results,
            // Loud degraded markers. WI-4214 (most specific first): the semantic
            // leg failed outright and these hits came from the embed-free lexical
            // fallback — token matches only, paraphrase recall is out, so a thin/
            // empty `results` may be a false miss. Else EI-9031: the embedder is
            // on a reduced-breadth fallback (cooldown), same false-miss caveat.
            ...(overloadDegradedReason
              ? { degraded: true, degraded_reason: overloadDegradedReason, fallback: 'lexical' }
              : embeddingDegraded
                ? { degraded: true, degraded_reason: 'embedding_backend_degraded' }
                : {}),
            // Loud tier marker (D-004): a non-full session sees WHY hits are
            // clipped and how to widen (payloadTier:"full").
            ...(sessionTier === 'trimmed' || sessionTier === 'standard'
              ? { payload_tier: sessionTier }
              : {}),
          }),
        },
      ],
    };
  },
});
