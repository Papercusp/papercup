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
import { getMemoryBackend } from '../../memory/backend';
import { anchorMetadata } from '../../memory/anchors';
import { checkConflicts } from '../../memory/conflict-check';
import { createAnthropicJudge } from '../../memory/anthropic-judge';
import { persistAnchorsSql } from '../../memory/persist-anchors';
import { getSessionUserOrDefault } from '../../auth';

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

export default defineTool({
  name: 'memory:remember',
  capability: 'memory:write',
  description:
    'Store a STABLE fact about the user into persistent memory. Use one of 4 kinds (user / feedback / project / reference). For transient state, use coord — not memory.',
  guidance: {
    when:
      'When the user says "remember X" / "don\'t forget Y" / "next time…" / "from now on…", OR when YOU notice an error you made that would recur without persistence. ALWAYS inform the user out loud ("I\'ll remember that"). For project-specific facts, pass harness_slug — the fact then surfaces for anyone working in that harness.',
    notWhen:
      'Default scope is per-user. Do not pass harness_slug for personal preferences. For IN-FLIGHT / ephemeral state (what you are doing right now), use coord (coord:declare-intent / coord:send) — it is delta-delivered, not a semantic store.',
    chaining:
      'After writing, the persona prompt will surface this entry on the next turn\'s pre-turn injection. No need to call memory:search to verify.',
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
    content: z.string().min(1).max(2000),
    kind: z.enum(KINDS),
    harness_slug: z.string().optional()
      .describe('Scope to a specific harness (project). Anyone with access to that harness will see this memory in their recall. Omit for a personal (per-user) fact.'),
    force: z.boolean().optional()
      .describe('Bypass the dedup-on-write similarity check (P-016). Use only when knowingly writing a near-duplicate the agent has decided to keep separate. Default: false.'),
    workspace: z.string().optional()
      .describe('Superuser-only: from an UNSCOPED session, tag the write under THIS workspace (the resolved workspace lands in metadata.workspace_id). Scoped/power-user sessions ignore it.'),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason }) }],
      };
    }
    let scopeKey: string;
    let scope: 'user' | 'harness';
    if (args.harness_slug) {
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
      workspace_id: ctx.principal.workspaceId,
      created_by: user.id,
      display_name: user.display_name,
    };
    if (args.harness_slug) metadata.harness_slug = args.harness_slug;

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
    if (dedupEnabled() && !args.force) {
      try {
        const neighbors = await backend.search(args.content, {
          scope: scopeKey,
          limit: DEDUP_TOP_K,
        });
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

        // P-017: conflict-check on the top-K neighbors (semantic
        // similarity didn't trip dedup, but the new fact may directly
        // contradict an existing one — Haiku judges). Same posture as
        // dedup: feature-flagged, failures fall through to write,
        // bypassable via force=true.
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

    const { ids } = await backend.remember(args.content, {
      scope: scopeKey,
      kind: args.kind,
      metadata,
    });

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

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, ids }) }],
    };
  },
});
