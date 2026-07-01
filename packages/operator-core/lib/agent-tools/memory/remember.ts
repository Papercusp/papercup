/**
 * memory:remember — explicit add to the persistent memory store.
 *
 * Brain calls this when the user says "remember X" or when the brain
 * itself notices an error/preference that would recur without
 * persistence. The persona prompt instructs the brain to ALWAYS
 * inform the user out loud ("I'll remember that") — never ask.
 *
 * userId is resolved server-side from the session cookie. Brain does
 * NOT pass it; the route guarantees the memory lands on the right user.
 *
 * Storage goes through the neutral `MemoryBackend` seam
 * (generalize-memory-backend-swappable-2026-06-05) — which store
 * actually holds the fact is a config flip (`PAPERCUSP_MEMORY_BACKEND`),
 * not a handler concern. Dedup + conflict checking ride the neutral
 * `search` (scored entries); anchor extraction is operator-side.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout, embedFailureReason } from '../../memory/op-deadline';
import { anchorMetadata } from '../../memory/anchors';
import { checkConflicts, conflictCheckEnabled } from '../../memory/conflict-check';
import { createAnthropicJudge } from '../../memory/anthropic-judge';
import { persistAnchorsSql } from '../../memory/persist-anchors';
import { getSessionUserOrDefault } from '../../auth';
import { hardText, LIMITS } from '../limits';

// The store holds only STABLE facts (docs-and-memory-as-projections-2026-06-05 D-006).
// The `ephemeral` kind was retired — ephemeral state belongs in coord (delta-
// delivered, never re-pushed), not in a semantic store.
//
// Taxonomy unified on the Claude-file generation (memory-taxonomy-and-debt-
// followups D-001): user (who they are) / feedback (how to work — corrections
// AND confirmed approaches) / project (ongoing work context) / reference
// (pointers + hard-won technical facts). The legacy mem0 kinds
// (identity/preference/correction) still read fine — typeForKind keeps their
// mappings — but new writes use the unified set.
const KINDS = ['user', 'feedback', 'project', 'reference'] as const;

/**
 * P-016: dedup-on-write similarity threshold. Tunable via env. A score
 * above this against the top-K nearest existing memory in the same
 * scope triggers a "similar_exists" rejection (bypassable via
 * `force: true`).
 *
 * Disabled by default (set PAPERCUSP_MEMORY_DEDUP=on to enable).
 * Ramp-up plan: ship off; turn on once Layer 1 audit reports the
 * actual dedup pressure isn't going to false-positive on real writes.
 *
 * Evaluated at call time (not module load) so tests can flip the env
 * per-test without resetting the module.
 */
function dedupEnabled(): boolean {
  return process.env.PAPERCUSP_MEMORY_DEDUP === 'on';
}
function dedupThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_DEDUP_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.9;
}
const DEDUP_TOP_K = 3;

// EI-2032: memory↔agent-insights boundary nudge. Memory is for SHORT facts
// recalled semantically EVERY turn; long-form runbooks belong in agent-insights
// (versioned MDX, pulled on demand). A write that is large AND structured
// (markdown headers / many bullets / many lines) reads like a runbook parked in
// the wrong store — the exact overlap the audit found (36 memories >2KB). Return
// a NON-BLOCKING hint steering it to agent-insights (mirrors the Claude-local
// memory-boundary-check.mjs nudge); the write still lands. Tunable via env.
const RUNBOOK_HINT_MIN_CHARS = (() => {
  const raw = Number(process.env.PAPERCUSP_MEMORY_RUNBOOK_HINT_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1200;
})();
export function runbookShapeHint(content: string): string | null {
  if (!content || content.length < RUNBOOK_HINT_MIN_CHARS) return null;
  const lines = content.split('\n');
  const headers = lines.filter((l) => /^\s{0,3}#{1,6}\s/.test(l)).length;
  const bullets = lines.filter((l) => /^\s*(?:[-*]|\d+[.)])\s/.test(l)).length;
  const structured = headers >= 1 || bullets >= 3 || lines.length >= 6;
  if (!structured) return null;
  return (
    `This memory is ${content.length} chars and reads like a runbook (multi-section). ` +
    `Memory is for SHORT facts recalled every turn; long-form runbooks belong in ` +
    `agent-insights — author an MDX under apps/operator-docs/src/content/docs/agent-insights/ ` +
    `(or harness:docs) and keep the memory to a one-line takeaway + a pointer. ` +
    `(Stored anyway — this is a nudge, not a block.)`
  );
}

export default defineTool({
  name: 'memory:remember',
  capability: 'memory:write',
  description:
    'Store a STABLE fact about the user into persistent memory, kept VERBATIM as written. Use one of 4 kinds (user / feedback / project / reference). Write ONE tight, self-contained fact per call. For transient state, use coord — not memory.',
  guidance: {
    when:
      'When the user says "remember X" / "don\'t forget Y" / "next time…" / "from now on…", OR when YOU notice an error you made that would recur without persistence. ALWAYS inform the user out loud ("I\'ll remember that"). For project-specific facts, pass harness_slug — the fact then surfaces for anyone working in that harness. Write ONE self-contained fact per call, tightly phrased: it is stored EXACTLY as written (no server-side rewriting or condensing), so make it stand on its own, lead with the searchable terms/anchors (file paths, F-NNN, backticked symbols), and drop conversational preamble.',
    notWhen:
      'Default scope is per-user. Do not pass harness_slug for personal preferences. For IN-FLIGHT / ephemeral state (what you are doing right now), use coord (coord:declare-intent / coord:send) — it is delta-delivered, not a semantic store.',
    chaining:
      'After writing, the persona prompt will surface this entry on the next turn\'s pre-turn injection. No need to call memory:search to verify.',
    seeAlso: [
      'memory:search (recall / dedup before writing a new fact)',
      'memory:update (amend an existing memory instead of duplicating)',
      'coord:declare-intent (in-flight state belongs here, not in a durable memory)',
    ],
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // Cross-workspace store (see memory:search) — handler rides getMemoryBackend /
  // getOrgPg, never ctx.tx. crossWorkspace:true lets an UNSCOPED superuser (psu)
  // session write instead of failing `workspace_required`.
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z.object({
    content: hardText(LIMITS.CONTENT),
    kind: z.enum(KINDS),
    harness_slug: z.string().optional()
      .describe('Scope to a specific harness (project). Anyone with access to that harness will see this memory in their recall. Omit for a personal (per-user) fact.'),
    hive_slug: z.string().optional()
      .describe("Scope to a Hive's SHARED pool (learning-packs P-004) — every agent in every member harness of that hive recalls it. Use for discovered project conventions (test command, build path, design system) the whole hive should inherit. Mutually exclusive with harness_slug."),
    force: z.boolean().optional()
      .describe('Bypass the dedup-on-write similarity check (P-016). Use only when knowingly writing a near-duplicate the agent has decided to keep separate. Default: false.'),
    workspace: z.string().optional()
      .describe('Superuser-only: from an UNSCOPED session, tag the write under THIS workspace (the resolved workspace lands in metadata.workspace_id). Scoped/power-user sessions ignore it.'),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    // B1: bound the connectivity probe — `available()` itself hangs when the
    // store is wedged (the 2026-06-19 outage), so a deadline here is the
    // difference between a fast `memory_timeout` and an infinite hang.
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:remember available');
      if (!avail.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason }) }],
        };
      }
    } catch (err) {
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout' }) }],
        };
      }
      throw err;
    }
    if (args.harness_slug && args.hive_slug) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'harness_slug and hive_slug are mutually exclusive — pick the pool the fact belongs to.' }) }],
      };
    }
    let scopeKey: string;
    let scope: 'user' | 'harness' | 'hive';
    if (args.hive_slug) {
      // learning-packs P-004: the Hive's shared pool — recalled by every agent
      // in every member harness (injection resolves member→hive).
      scopeKey = `hive:${args.hive_slug}`;
      scope = 'hive';
    } else if (args.harness_slug) {
      scopeKey = `harness:${args.harness_slug}`;
      scope = 'harness';
    } else {
      scopeKey = user.id;
      scope = 'user';
    }

    const metadata: Record<string, unknown> = {
      scope,
      // The principal carries the resolved workspace (incl. a per-call
      // `workspace` pin from an unscoped SU session). The old read,
      // `ctx.workspaceId`, was never populated on principal-gated handlers
      // — every prior write stored workspace_id: undefined (P-004).
      workspace_id: ctx.principal?.workspaceId,
      created_by: user.id,
      display_name: user.display_name,
    };
    if (args.harness_slug) metadata.harness_slug = args.harness_slug;
    if (args.hive_slug) metadata.hive_slug = args.hive_slug;

    // Phase 4 P-015: extract structural anchors from the body so Layer 1
    // (P-019) can later validate them with zero LLM cost. Anchors are
    // stored in metadata AND persisted to harness_shared.memory_anchors
    // post-add (below) so the audit + UI paths can find them.
    const anchors = anchorMetadata(args.content);
    if (anchors) {
      metadata.anchors = anchors.anchors;
      metadata.anchor_count = anchors.anchor_count;
    }

    // Phase 4 P-016: dedup-on-write. Search the same scope for
    // near-duplicates before inserting. If similarity exceeds the
    // threshold, refuse and surface the existing memory_id so the agent
    // can decide to merge / forget-then-rewrite / force-through.
    //
    // Defensive: any failure of the search falls through to insert. The
    // dedup check is a hygiene layer, never load-bearing. Same posture
    // as injection.ts (failures degrade silently).
    // EI-2032: run the neighbor search when EITHER dedup (opt-in) OR the
    // conflict-check (default ON) is enabled. Previously the conflict-check was
    // nested INSIDE `if (dedupEnabled())`, so with dedup off-by-default the
    // contradiction gate never fired — a new memory could silently contradict an
    // existing one. Decoupled here: dedup-rejection stays gated on dedupEnabled()
    // (it is false-positive-prone, hence opt-in), but the conflict-check runs
    // independently whenever it is enabled.
    if (!args.force && (dedupEnabled() || conflictCheckEnabled())) {
      try {
        // B1: bounded — a search hang must not block the write. On timeout this
        // throws into the surrounding catch, which proceeds with the write
        // (degraded dedup/conflict), exactly as a search error already does.
        const neighbors = await withMemoryToolTimeout(
          backend.search(args.content, {
            scope: scopeKey,
            limit: DEDUP_TOP_K,
          }),
          'memory:remember dedup-search',
        );
        // P-016 dedup-on-write (opt-in via PAPERCUSP_MEMORY_DEDUP): refuse a
        // near-duplicate above the similarity threshold.
        if (dedupEnabled()) {
          const top = neighbors[0];
          const topScore = typeof top?.score === 'number' ? top.score : null;
          if (top && topScore !== null && topScore >= dedupThreshold()) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  reason: 'similar_exists',
                  similar_memory_id: top.id,
                  similar_score: topScore,
                  similar_text: top.text,
                  hint: 'Set force=true to write anyway, or call memory:forget on the similar memory first.',
                }),
              }],
            };
          }
        }

        // P-017: conflict-check on the top-K neighbors (default ON via
        // PAPERCUSP_MEMORY_CONFLICT_CHECK; checkConflicts self-gates + degrades).
        // Catches a new fact that directly CONTRADICTS a near neighbor (Haiku
        // judges) even when dedup similarity did not trip — runs independently of
        // the dedup flag now. Bypassable via force=true.
        if (neighbors.length > 0) {
          const conflict = await checkConflicts({
            newText: args.content,
            neighbors: neighbors.map((n) => ({ id: n.id, text: n.text, score: n.score })),
            judge: createAnthropicJudge(),
          });
          if (conflict.conflicts.length > 0) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  reason: 'conflict',
                  conflicts: conflict.conflicts,
                  hint: 'New memory directly contradicts existing memories. memory:forget the contradicted entries first, or pass force=true to write anyway.',
                }),
              }],
            };
          }
        }
      } catch {
        // dedup or conflict check failed — proceed with the write (degraded mode).
      }
    }

    // `available()` is only a CONNECTIVITY probe (the cosine leg's
    // reachability) — a RUNTIME embedder failure surfaces here, where
    // `backend.remember` THROWS `MemoryUnavailableError` per the backend
    // contract (backend.ts: "available() is the non-throwing probe; every
    // other method throws when the store is unreachable"). Without this
    // catch the throw escapes to the MCP dispatch wrapper, which renders it
    // as `{ isError: true, content: 'handler_error: memory backend
    // unavailable: <reason>' }` — an opaque, crash-shaped result that hides
    // the structured `reason` the agent can act on. Map it back to the SAME
    // clean `{ ok: false, reason }` envelope the upfront-unavailable branch
    // returns, so a down embedder reads identically whether it trips at
    // probe time or call time. A NON-MemoryUnavailableError throw is a real
    // bug — let it propagate to the framework's handler_error envelope.
    //
    // NOTE: this only makes the FAILURE legible — the write is still LOST on
    // an embedder outage (no degrade-to-lexical / vector-deferral here). The
    // deeper fix lives in the BACKEND and is an owner design decision (see
    // the GAP-1 FLAG in the agent report); this handler catch does not
    // attempt it.
    let ids: string[];
    try {
      // B1: bounded so a wedged embedder/store returns `memory_timeout` instead
      // of riding the ~55–60s transport cap out to an apparent infinite hang.
      ({ ids } = await withMemoryToolTimeout(backend.remember(args.content, {
        scope: scopeKey,
        kind: args.kind,
        metadata,
        // Store the agent's text VERBATIM (infer:false) — do NOT run mem0's
        // LLM fact-extraction/condense step on the explicit single-fact write
        // path. That step is an unbounded Anthropic (Haiku) call with no
        // timeout; under the busy-fleet 429 backoff it routinely outlived the
        // MCP client's request timeout (~60s) and dropped the transport
        // mid-call — the PG insert committed, but the caller saw "transport
        // dropped; response lost" and blind-retried into near-duplicates
        // (EI-178). An explicit remember is already a clean one-line fact the
        // agent wrote deliberately, so condensation adds little here; the
        // conversation-extraction path (backend.rememberConversation) keeps the
        // LLM extraction, where pulling facts out of a chat window earns it.
        verbatim: true,
      }), 'memory:remember remember'));
    } catch (err) {
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout' }) }],
        };
      }
      if (err instanceof MemoryUnavailableError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err.reason }) }],
        };
      }
      // mem0-timeout-fix-2026-06-24: a fast-failed embed (org TPM 429 / 5xx / stall) surfaces
      // as a CLEAN reason so the agent narrates accurately instead of as an opaque handler_error.
      const embedReason = embedFailureReason(err);
      if (embedReason) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: embedReason }) }],
        };
      }
      throw err;
    }

    // Live-refresh the settings memory page (userMemory.list sync query) —
    // fire-and-forget, never load-bearing (memory-settings-page-refresh P-008).
    void import('../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('userMemory.list'))
      .catch(() => { /* best-effort */ });

    // Phase 4 P-015: persist anchors to harness_shared.memory_anchors so
    // Layer 1 (audit-memory-anchors.ts) and the settings-UI broken_anchors
    // enrichment can find them. Fire-and-forget — never load-bearing on
    // the write path; same posture as bumpLastSurfacedSql in injection.ts.
    if (anchors && ids.length > 0) {
      void (async () => {
        try {
          const { sql } = getOrgPg();
          for (const id of ids) {
            await persistAnchorsSql(sql, id, anchors.anchors);
          }
        } catch {
          /* swallow — never load-bearing on the store write path */
        }
      })();
    }

    // EI-2032: nudge runbook-shaped writes toward agent-insights (non-blocking).
    const runbookHint = runbookShapeHint(args.content);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, ids, ...(runbookHint ? { hint: runbookHint } : {}) }),
      }],
    };
  },
});
