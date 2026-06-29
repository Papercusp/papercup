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
 * score }] }.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend, type MemoryEntry } from '../../memory/backend';
import { isMemoryWorkspaceScopedRecallOn, keepUserPoolHitForWorkspace } from '../../memory/workspace-scope-recall';
import { MemoryTimeoutError, withMemoryToolTimeout, embedFailureReason } from '../../memory/op-deadline';
import { getSessionUserOrDefault } from '../../auth';
import { loadHarnessRegistry } from '../../harness-registry';
import { isEphemeralBenchmarkHarnessSlug } from '../../harness/improvements/watchdog';
import { narrowHarnessSlugsToSessionHive } from '../../memory/hive-scope';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../../flag-distinct-id';

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
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const limit = args.limit ?? 8;

    // B1 (infra-fail-fast-build-integrity-2026-06-19): bound EVERY backend call
    // with a deadline. `available()` itself can hang when the store is wedged
    // (the 2026-06-19 outage), so it is inside the guarded region too. A timeout
    // returns the same `{ ok:false, reason, results:[] }` envelope as a clean
    // "store down" probe — but with `memory_timeout` — instead of an infinite hang.
    let hits: MemoryEntry[];
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:search available');
      if (!avail.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason, results: [] }) }],
        };
      }

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
      // The backend fans out per scope (limit applies per pool), merges,
      // de-dupes by id and sorts by score; we apply the global cap here.
      hits = await withMemoryToolTimeout(backend.search(args.query, { scope, limit }), 'memory:search search');
    } catch (err) {
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout', results: [] }) }],
        };
      }
      // mem0-timeout-fix-2026-06-24: a fast-failed embed (org TPM 429 / 5xx / stall) surfaces
      // as a CLEAN reason + empty results, not an opaque handler_error.
      const embedReason = embedFailureReason(err);
      if (embedReason) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: embedReason, results: [] }) }],
        };
      }
      throw err;
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

    const results = hits.slice(0, limit).map(toWireRow);

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
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results }) }],
    };
  },
});
