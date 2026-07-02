/**
 * coord:orient — the COMPOUND agent wake-orientation + session-bootstrap read
 * (code-execution-tool-orchestration B-CX-1B; extended by tool-call-batching-wrappers
 * P-005). The worker's "where do I stand / what should I work on / what do I know /
 * what changed" in ONE call: my assignments (+ lane + load), the claimable backlog, my
 * inbox summary, the recent plan-events delta, and — when I pass `intent` — a memory
 * recall for it plus a coord:declare-intent so peers see me.
 *
 * Measured (harness_shared.tool_invocations, mcp transport, 14d): the
 * `fleet:assignments ↔ coord:inbox ↔ work_items:list/get` cluster is the dominant
 * orientation flow — triples like `memory:search → coord:inbox → fleet:assignments`
 * (36), `fleet:assignments → coord:inbox → work_items:get` (35). The MANDATED
 * session-bootstrap (memory:search + coord:inbox + coord:plan-events +
 * coord:declare-intent) is four MORE round-trips agents pay every wake — this collapses
 * the whole ritual into one.
 *
 * orient composes: fleet:assignments(me) + work_items:list(claimable) +
 * coord:inbox(summary) + coord:plan-events(delta) [+ memory:search(intent) +
 * coord:declare-intent(intent) when `intent` is passed] → 1 round-trip. It is the
 * worker/work-centric sibling of coord:glance (the fleet-HEALTH read). Composition is
 * the in-process re-dispatch pattern (see `_compound-dispatch.ts`) — each sub-read is
 * gated + telemetry-logged like a direct call, run SEQUENTIALLY so they never contend on
 * the caller's single ctx connection. The bootstrap folds are BEST-EFFORT (a slow/timed-
 * out memory recall, or a declare the caller lacks coord:write for, degrades to a null/
 * false field rather than failing orientation) and the result is bounded/COMPACT
 * (tool-call-batching-wrappers D-008): a wrapper that dumped raw concatenated sub-results
 * would re-introduce the very token cost it exists to remove.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveSelfRef } from '../self-marker';
import { COORD_ROLES } from '../roles';
import { inProcessCall, type InnerCall } from '../../_compound-dispatch';
import { hardText, LIMITS } from '../../limits';
import { shapeOrient } from './orient-shape';

/** D-008 COMPACT bounds — keep the folded payload small so it doesn't re-enter
 *  context as bulk input on every later turn. */
const MEMORY_TEXT_CAP = 200;
const MEMORY_HITS_CAP = 10;
const PLAN_EVENTS_FOLD = 10;
const FLEET_CATCHUP_FOLD = 8;
const FLEET_CATCHUP_CAP = 25;
/** Reuse-at-orient bounds (code-run-adoption): surface a few intent-relevant recipes so an
 *  agent reuses an EXISTING code:run script instead of hand-looping/re-authoring — kept tiny
 *  so it never re-enters context as bulk on later turns. */
const RECIPES_DEFAULT = 3;
const RECIPES_CAP = 5;
const RECIPE_TITLE_CAP = 120;

export interface OrientArgs {
  harness?: string;
  claimableState?: string;
  claimableLimit?: number;
  inboxLimit?: number;
  // P-005 — the session-bootstrap folds (tool-call-batching-wrappers):
  /** Your one-line intent for THIS turn. When set: DECLARED to peers
   *  (coord:declare-intent) AND used as the memory:search recall query — the
   *  two halves of the bootstrap that need an intent, folded into the one call. */
  intent?: string;
  /** Explicit memory:search query (overrides `intent` for the recall fold). */
  memoryQuery?: string;
  /** Plan slug for the declared lane (used with `intent`). */
  planSlug?: string;
  /** Plan items to CLAIM as your lane (used with `intent` + `planSlug`). */
  planItems?: string[];
  /** Max memory hits to fold (default 5, hard-capped 10). */
  memoryLimit?: number;
  /** Fold the recent plan-events delta (default true). */
  includePlanEvents?: boolean;
  /** Only plan-events strictly later than this ISO timestamp. */
  planEventsSince?: string;
  /** Surface reusable code:run recipes relevant to `intent`/`memoryQuery` (default true). */
  includeRecipes?: boolean;
  /** Max relevant recipes to surface (default 3, hard-capped 5). */
  recipesLimit?: number;
  /** Fold a bounded catch-up slice of YOUR fleet's audience-history when you belong to a
   *  named fleet — the auto "what did my fleet say while I was away" at wake (default true). */
  includeFleetCatchUp?: boolean;
  /** Max fleet catch-up messages to fold (default 8, hard-capped 25). */
  fleetCatchUpLimit?: number;
}

export interface OrientMemoryHit {
  id?: unknown;
  memory?: string;
  score?: unknown;
}

export interface OrientResult {
  ok: boolean;
  /** fleet:assignments scoped to me (assignments, lane, load, orphans). */
  me: unknown;
  /** The claimable backlog (work_items:list, default state=todo). */
  claimable: unknown[];
  /** coord:inbox folded down to its summary + the most-recent bounded entries. */
  inbox: { summary?: unknown; recent?: unknown };
  /** memory:search recall for `intent`/`memoryQuery` — bounded hits; null if the
   *  recall failed/timed out; absent when no query was given. */
  memory?: { query: string; hits: OrientMemoryHit[] } | null;
  /** coord:plan-events delta — newest few + the true total; null on failure;
   *  absent when includePlanEvents:false. */
  planEvents?: { total: number; recent: unknown[] } | null;
  /** Reusable code:run recipes relevant to `intent`/`memoryQuery` (recipes:search) —
   *  id + title + run/similarity, bounded. Reuse one (recipes:run) instead of hand-looping
   *  or re-authoring. null on failure; absent when no query or includeRecipes:false. */
  recipes?: Array<{ id?: unknown; title?: string; runCount?: unknown; similarity?: unknown }> | null;
  /** Whether the optional coord:declare-intent succeeded (present only when
   *  `intent` was passed; false = the caller lacked coord:write). */
  intentDeclared?: boolean;
  /** A bounded slice of the caller's fleet audience-history (coord:catch-up on
   *  @fleet:<own slug>) — present only when the caller belongs to a fleet; null on a
   *  failed fold. The auto-catch-up at wake. */
  fleetCatchUp?: { fleet: string; total: number; recent: unknown[] } | null;
}

/**
 * Pure composition over an injected `call`, run SEQUENTIALLY. The first three reads are
 * the core orientation (always run); the memory/plan-events/declare folds are the
 * additive session-bootstrap, each gated by its input and BEST-EFFORT. `ownerId` scopes
 * assignments to the caller; when undefined (unresolved loopback identity) assignments
 * are fleet-wide.
 */
export async function composeOrient(
  args: OrientArgs,
  call: InnerCall,
  ownerId: string | undefined,
): Promise<OrientResult> {
  const me = await call('fleet:assignments', {
    ...(ownerId ? { agent: ownerId } : {}),
    ...(args.harness ? { harness: args.harness } : {}),
  });
  const list = await call('work_items:list', {
    ...(args.harness ? { harness: args.harness } : {}),
    state: args.claimableState ?? 'todo',
    limit: args.claimableLimit ?? 20,
  });
  const inbox = (await call('coord:inbox', {
    limit: args.inboxLimit ?? 10,
    max_body_chars: 300,
  })) as { summary?: unknown; entries?: unknown } | undefined;

  // work_items:list returns the bare array (its `result` schema), but be defensive
  // about the wrapped shapes the unwrap may yield.
  const claimable = Array.isArray(list)
    ? list
    : ((list as { data?: unknown[]; items?: unknown[] } | null)?.data ??
       (list as { data?: unknown[]; items?: unknown[] } | null)?.items ??
       []);

  const result: OrientResult = {
    ok: true,
    me,
    claimable,
    inbox: { summary: inbox?.summary, recent: inbox?.entries },
  };

  // ── memory:search recall — only when a query is available (a query-less recall is
  // meaningless). BEST-EFFORT: memory p95 is multi-second and can time out; that must
  // not break orientation.
  const memQuery = args.memoryQuery ?? args.intent;
  if (memQuery) {
    const memLimit = Math.min(args.memoryLimit ?? 5, MEMORY_HITS_CAP);
    try {
      const mem = (await call('memory:search', {
        query: memQuery,
        ...(args.harness ? { harness_slug: args.harness } : {}),
        limit: memLimit,
      })) as { results?: OrientMemoryHit[] } | undefined;
      result.memory = {
        query: memQuery,
        hits: (mem?.results ?? []).slice(0, memLimit).map((r) => ({
          id: r.id,
          memory: typeof r.memory === 'string' ? r.memory.slice(0, MEMORY_TEXT_CAP) : undefined,
          score: r.score,
        })),
      };
    } catch {
      result.memory = null;
    }
  }

  // ── coord:plan-events — the "what plans changed" delta (default on; the bootstrap's
  // third leg). Already result-bounded server-side; we keep the newest few.
  if (args.includePlanEvents !== false) {
    try {
      const pe = (await call('coord:plan-events', {
        ...(args.planEventsSince ? { since_ts: args.planEventsSince } : {}),
        limit: PLAN_EVENTS_FOLD,
      })) as { events?: unknown[]; total?: number } | undefined;
      const events = Array.isArray(pe?.events) ? (pe!.events as unknown[]) : [];
      result.planEvents = {
        total: typeof pe?.total === 'number' ? pe.total : events.length,
        recent: events.slice(0, PLAN_EVENTS_FOLD),
      };
    } catch {
      result.planEvents = null;
    }
  }

  // ── fleet catch-up — when the caller belongs to a named fleet, fold a bounded slice of
  // that fleet's audience-keyed history so a freshly-joined/returning member auto-catches-up
  // at wake (the pull counterpart to @fleet: broadcasts, which are NOT auto-polled). Gated +
  // BEST-EFFORT: resolve the caller's fleet via coord:whoami, then coord:catch-up; a non-fleet
  // caller or any failure degrades to absent/null. (fleet-messaging-integrate-and-land P-006)
  if (args.includeFleetCatchUp !== false) {
    try {
      const who = (await call('coord:whoami', {})) as { fleetSlug?: string | null } | undefined;
      const fleetSlug = who?.fleetSlug ?? null;
      if (fleetSlug) {
        const cuLimit = Math.min(args.fleetCatchUpLimit ?? FLEET_CATCHUP_FOLD, FLEET_CATCHUP_CAP);
        const cu = (await call('coord:catch-up', {
          audience: `@fleet:${fleetSlug}`,
          limit: cuLimit,
        })) as { total?: number; rows?: unknown[] } | undefined;
        const rows = Array.isArray(cu?.rows) ? (cu!.rows as unknown[]) : [];
        result.fleetCatchUp = {
          fleet: fleetSlug,
          total: typeof cu?.total === 'number' ? cu.total : rows.length,
          recent: rows.slice(0, cuLimit),
        };
      }
    } catch {
      result.fleetCatchUp = null;
    }
  }

  // ── recipes:search — surface reusable code:run RECIPES relevant to this turn's intent,
  // so an agent batches via an EXISTING recipe instead of hand-looping or re-authoring
  // (code-run-adoption: reuse-at-orient closes the "I didn't know one existed" gap — the
  // measured bottleneck is awareness, not authoring). Keyed off the same intent/memoryQuery
  // as the recall. BEST-EFFORT: a missing intel:read cap or a slow search degrades to null,
  // never breaks orientation. COMPACT: id/title/runCount/similarity only.
  const recipeQuery = args.intent ?? args.memoryQuery;
  if (recipeQuery && args.includeRecipes !== false) {
    const recLimit = Math.min(args.recipesLimit ?? RECIPES_DEFAULT, RECIPES_CAP);
    try {
      const rec = (await call('recipes:search', {
        query: recipeQuery,
        limit: recLimit,
      })) as { recipes?: Array<{ id?: unknown; title?: unknown; runCount?: unknown; similarity?: unknown }> } | undefined;
      result.recipes = (rec?.recipes ?? []).slice(0, recLimit).map((r) => ({
        id: r.id,
        title: typeof r.title === 'string' ? r.title.slice(0, RECIPE_TITLE_CAP) : undefined,
        runCount: r.runCount,
        similarity: r.similarity,
      }));
    } catch {
      result.recipes = null;
    }
  }

  // ── coord:declare-intent — only when an intent is given (a WRITE; independently
  // capability-gated at re-dispatch, so a read-only caller gets intentDeclared:false
  // rather than an escalation). BEST-EFFORT.
  if (args.intent) {
    try {
      await call('coord:declare-intent', {
        intent: args.intent,
        ...(args.planSlug ? { current_plan_slug: args.planSlug } : {}),
        ...(args.planItems ? { items: args.planItems } : {}),
        ...(args.harness ? { harness: args.harness } : {}),
      });
      result.intentDeclared = true;
    } catch {
      result.intentDeclared = false;
    }
  }

  return result;
}

export default defineTool({
  name: 'coord:orient',
  description:
    "One agent wake-orientation + session-bootstrap read: your assignments (+lane+load), " +
    "the claimable backlog, your inbox summary, and the recent plan-events delta — plus, " +
    "when you pass `intent`, a memory recall for it AND a coord:declare-intent so peers see " +
    "you. Collapses the mandated bootstrap (memory:search + coord:inbox + coord:plan-events " +
    "+ coord:declare-intent, with assignments + claimable) into ONE round-trip. coord:glance " +
    'is the fleet-health read.',
  guidance: {
    when:
      'At the START of a turn / on waking. Pass `intent` (your one-line task) to get, in ' +
      'ONE round-trip: assignments + claimable backlog + inbox summary + recent plan-events ' +
      '+ a memory recall for `intent` + your intent DECLARED to peers — the whole mandated ' +
      'bootstrap. Omit `intent` for a lighter re-orientation (no recall / no declare).',
    notWhen:
      'Fleet-wide wake/health for a status surface (coord:glance); full message bodies/history ' +
      '(coord:inbox); the whole presence roster (coord:presence). Do NOT pass a throwaway ' +
      '`intent` just to fire the declare. After a successful orient do NOT re-call ' +
      'coord:plan-events / memory:search / coord:inbox / coord:declare-intent — it ALREADY ' +
      'returned (and declared) them this turn.',
    chaining:
      'Bundles: fleet:assignments + work_items:list + coord:inbox + coord:plan-events ' +
      '[+ memory:search + recipes:search + coord:declare-intent when `intent` is set] — prefer ' +
      'this at wake over calling them separately. If `recipes` comes back with a close hit, ' +
      'recipes:run it instead of hand-looping/re-authoring. → work_items:pickup { id, intent }.',
  },
  capability: 'coord:read',
  // tool-call-batching-wrappers P-010 — composite marker: the primitives this bundles.
  // Drives the `composition: 'composite'` tag (agent_tools:list) + the bounded
  // back-pointer on each of these primitives' catalog entries (prompt-assembly).
  replaces: [
    'fleet:assignments',
    'work_items:list',
    'coord:inbox',
    'coord:plan-events',
    'memory:search',
    'recipes:search',
    'coord:declare-intent',
    'coord:catch-up',
  ],
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(80).optional().describe('Scope assignments + claimable + recall + declare to this harness.'),
    claimableState: z.string().max(40).optional().describe("Work-item state for the claimable list (default 'todo')."),
    claimableLimit: z.number().int().positive().max(100).optional().describe('Max claimable items (default 20).'),
    inboxLimit: z.number().int().positive().max(50).optional().describe('Max recent inbox entries (default 10).'),
    intent: hardText(LIMITS.ANNOTATION)
      .optional()
      .describe('Your one-line intent for this turn — DECLARED to peers (coord:declare-intent) AND used as the memory:search recall query. The bootstrap-in-one-call lever.'),
    memoryQuery: z.string().max(500).optional().describe('Explicit memory:search query (overrides `intent` for recall).'),
    planSlug: z.string().max(120).optional().describe('Plan slug for the declared lane (used with `intent`).'),
    planItems: z
      .array(z.string().max(20))
      .max(40)
      .optional()
      .describe('Plan items to claim as your lane (used with `intent` + `planSlug`).'),
    memoryLimit: z.number().int().positive().max(10).optional().describe('Max memory hits to fold (default 5).'),
    includePlanEvents: z.boolean().optional().describe('Fold the recent plan-events delta (default true).'),
    planEventsSince: z.string().optional().describe('Only plan-events strictly after this ISO timestamp.'),
    includeRecipes: z.boolean().optional().describe('Surface reusable code:run recipes relevant to `intent` (default true).'),
    recipesLimit: z.number().int().positive().max(5).optional().describe('Max relevant recipes to surface (default 3).'),
    includeFleetCatchUp: z.boolean().optional().describe("Fold a bounded catch-up of YOUR fleet's audience-history when you're in a named fleet (default true)."),
    fleetCatchUpLimit: z.number().int().positive().max(25).optional().describe('Max fleet catch-up messages to fold (default 8).'),
  }),
  // context-trimming-tiers P-012: orient is the fattest bootstrap read (one
  // unshaped call measured ~43k tokens in the 2026-07-01 fleet incident). The
  // tier shapers project the SAME orientation with caps + fetch-pointers;
  // `payloadTier: 'full'` on any call returns the unshaped result.
  shape: {
    standard: (data, sctx) => shapeOrient(data, sctx.tier as 'standard'),
    trimmed: (data, sctx) => shapeOrient(data, sctx.tier as 'trimmed'),
  },
  async handler(args, ctx) {
    // Soft identity resolve — orient is a READ; a bare loopback caller without an
    // attributable coord identity still gets a (fleet-wide) orientation.
    let ownerId: string | undefined;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = undefined;
    }
    const result = await composeOrient(args, inProcessCall(ctx), ownerId);
    // Fold in the caller's own identity so the orientation states YOUR ownerId
    // explicitly (the roster/assignments it composes are about peers; `self` is
    // the "and this is you" anchor). Best-effort — omitted for an unattributable
    // caller. See self-marker.ts for why this is a response-layer overlay.
    const self = resolveSelfRef(ctx);
    const out = self ? { self, ...(result as object) } : result;
    // `{ data }` envelope (tool-data-shape ratchet P-003) so payload-tier
    // shaping + format-aware serialization apply. On the MCP transport this is
    // behavior-equivalent to the prior raw-JSON text (the re-encode path
    // already routed orient through the same serializer when TOON shrank it).
    return { data: out };
  },
});
