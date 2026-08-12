/**
 * tools:find — find tools by INTENT. The agent-facing front door to the
 * ~550-tool catalog (tool-discovery-for-weak-models-2026-06-30 WS3).
 *
 * Hybrid lexical + semantic search (the committed `cupboard/tool-find.ts`
 * floored-union core): the lexical leg is exact-name-authoritative, the semantic
 * leg broadens recall so "feature flag" finds `flags:*` and "spawn a worker"
 * finds `cup:spawn` even with no shared words. Better than omp's keyword-only
 * `search_tool_bm25`, and — unlike that omp-internal search — usable by
 * claude/codex too.
 *
 * The semantic embedding index over the catalog is built at BOOT
 * (`warmToolFindIndex`, fired once at module load) with a settings-driven
 * embedder via `buildQueryEmbedder` — so the semantic
 * leg is live for the FIRST agent call rather than each cold worker warming
 * lazily on first use (where rate-governed 551-tool warming may never finish
 * before a call lands, leaving agents perpetually on lexical-only). It rebuilds
 * only on catalog size drift, and the handler self-heals (re-invokes the build)
 * if the boot warm hasn't completed. Every embedding path degrades to
 * lexical-only on any failure (no embedder, admission shed, fetch error) and the
 * result's `semantic` field reports which leg ran — so the tool is always
 * functional and never silently pretends semantic ran.
 *
 * ONE EMBEDDING SPACE, and deliberately unnamed here. `buildQueryEmbedder` is
 * the SAME resolution the prose search uses, so the catalog index and every
 * prose column live in one space — measured 2026-08-08: both gemma@768, 296,452
 * session turns and 9,987 doc sections (P-019).
 *
 * ⚠ This comment used to say "currently openai, 384-d". It went stale when the
 * embedder moved, and a plan item was later written FROM IT asserting the app
 * ran two models at two dimensionalities. It does not, and never needed to —
 * the point of routing through `buildQueryEmbedder` is that this file holds no
 * opinion about model or width. Do not re-pin one here; a width named in prose
 * is a claim nothing can keep true. `findTools` carries a width guard for the
 * one mismatch that IS reachable: a boot-built index stranded in a different
 * space by a settings change mid-process.
 */
import { z } from 'zod';
import { defineTool, listAllProjectedTools, AGENT_ROLES } from '@papercusp/agent-mcp';
import { categoryOf } from '../../cupboard/tools-search';
import { schemaToText, type ToolDiscoveryEntry } from '../../cupboard/tools-discovery';
import { findTools, type Embedder } from '../../cupboard/tool-find';
import { buildQueryEmbedder, interactiveEmbedAcquireBudgetMs } from '../search/embedder';

/**
 * Build the live corpus from the projected-tool registry: name + description +
 * guidance.when + arg-schema text. The arg-schema text makes a tool's PARAMETERS
 * searchable/embeddable (so "set a flag by key" can match `flags:set`'s `key`
 * arg) and lets `tools:find` RETURN the schema with each hit. The embed text is
 * `name \n description \n when \n argSchema` — the richest intent signal for the
 * semantic leg.
 */
export function buildCorpus(): {
  corpus: ToolDiscoveryEntry[];
  embedText: Map<string, string>;
  /** EI-10882: name → the tool's declared RESPONSE shape (guidance.returns). */
  returnsByTool: Map<string, string>;
} {
  const corpus: ToolDiscoveryEntry[] = [];
  const embedText = new Map<string, string>();
  const returnsByTool = new Map<string, string>();
  for (const tool of listAllProjectedTools()) {
    if (!tool.expose.mcp) continue;
    const name = tool.expose.mcp.name;
    const when = tool.guidance?.when?.trim();
    const argSchema = schemaToText(tool.inputSchema);
    const returns = (tool.guidance as { returns?: string } | undefined)?.returns?.trim();
    if (returns) returnsByTool.set(name, returns);
    // Fold the "when to use" line into the searchable text — it's the richest
    // intent signal for both legs (lexical description weight + the embedding).
    const description = [tool.description, when].filter(Boolean).join(' ').trim() || null;
    corpus.push({
      tool: name,
      category: categoryOf(name),
      capability: tool.capabilities[0] ?? null,
      description,
      argSchema,
      provider: null,
      unit: null,
    } as unknown as ToolDiscoveryEntry);
    embedText.set(name, [name, tool.description, when, argSchema].filter(Boolean).join('\n'));
  }
  return { corpus, embedText, returnsByTool };
}

// ── Boot-time embedding index over the full catalog (module-scoped cache) ─────
// Built ONCE at startup (see warmToolFindIndex below) so the semantic leg is
// live for the FIRST agent call rather than each cold worker warming lazily on
// first use — the failure mode where rate-governed 551-tool warming never
// finishes before a call lands. Rebuilt only when the catalog size drifts (a
// plugin (un)registered tools), never on a per-row sweep.
let queryEmbedder: Embedder | null | undefined; // undefined = not yet resolved
let embIndex: Map<string, number[]> | null = null;
let indexedCount = 0; // corpus size the index was built for (rebuild on drift)
let building: Promise<void> | null = null; // non-null while an index build is in flight

async function getEmbedder(): Promise<Embedder | null> {
  if (queryEmbedder === undefined) {
    try {
      queryEmbedder = await buildQueryEmbedder({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
    } catch {
      queryEmbedder = null;
    }
  }
  return queryEmbedder;
}

/**
 * Embed every corpus row → `name → vector` map. Per-row failures (admission
 * shed / transient fetch error) are skipped — a partial index still broadens
 * recall. Pure over its inputs; exported so the index build is unit-testable
 * with a mock embedder.
 */
export async function buildEmbeddingIndex(
  embedText: ReadonlyMap<string, string>,
  embedder: Embedder,
): Promise<Map<string, number[]>> {
  const next = new Map<string, number[]>();
  for (const [name, text] of embedText) {
    try {
      const v = await embedder(text);
      if (Array.isArray(v) && v.length > 0) next.set(name, v);
    } catch {
      /* skip this tool — partial index still helps */
    }
  }
  return next;
}

/**
 * Build (or rebuild on size drift) the module-scoped embedding index. Idempotent
 * + single-flight: a no-op when fresh or when no embedder is configured (→
 * lexical-only), and concurrent callers share the one in-flight build. Returns
 * the in-flight promise (so a boot/test caller can await it) or null when there
 * is nothing to do.
 */
function ensureIndex(embedText: ReadonlyMap<string, string>, embedder: Embedder | null): Promise<void> | null {
  if (!embedder) return null; // unconfigured → lexical-only
  if (embIndex && indexedCount === embedText.size) return null; // fresh
  if (building) return building; // single-flight
  const size = embedText.size;
  building = buildEmbeddingIndex(embedText, embedder)
    .then((idx) => {
      embIndex = idx;
      indexedCount = size;
    })
    .catch(() => {
      /* leave the prior index in place; a later call retries */
    })
    .finally(() => {
      building = null;
    });
  return building;
}

/**
 * Boot entry point: resolve the embedder and build the catalog embedding index.
 * Fired once at module load (below) so the index warms from STARTUP. The
 * embedder is resolved BEFORE buildCorpus so the first `await` lets the rest of
 * the tool tree finish registering — the corpus is then read complete. Awaitable
 * for tests / explicit warmers; resolves once the index is ready (or immediately
 * when no embedder is configured).
 */
export async function warmToolFindIndex(): Promise<void> {
  const embedder = await getEmbedder();
  const { embedText } = buildCorpus();
  const p = ensureIndex(embedText, embedder);
  if (p) await p;
}

// Kick the warm off at module load (boot). Skipped under vitest — tests drive
// the index explicitly; and it self-heals on first call regardless (the handler
// re-invokes ensureIndex). Fire-and-forget: never blocks boot.
if (!process.env.VITEST) {
  void warmToolFindIndex().catch(() => {});
}

export default defineTool({
  name: 'tools:find',
  description:
    'Find tools by INTENT across the full ~550-tool catalog (hybrid lexical + semantic). Returns the ' +
    'best-matching tool names with their description, ARG schema, and declared RESPONSE shape ' +
    '(`returns`) — so you can write a code:run batch over a tool without calling it once just to learn ' +
    'its field names. e.g. tools:find("feature flag"), tools:find("spawn a worker"). ACTIVATION IS ' +
    'CONDITIONAL: on a seeded (small-surface) session the matches are added to your live tool list ' +
    '(activated:true) and are directly callable; on a full-catalog session there is nothing to expand ' +
    '(activated:false) — call them via tools:invoke. High-confidence runtime symptoms (slow/queued, ' +
    'connection-refused, no-window, change-live?, value-stale?) route their decisive diagnostic to hit #1. ' +
    'Always read `activated` + `howToCall` rather than ' +
    'assuming a direct call resolves.',
  guidance: {
    when:
      'You need a tool that is not in your loaded/core set and do not know its exact name — search by what you want to DO ' +
      '("set a feature flag", "spawn a worker bee").',
    notWhen:
      'The tool is already in your core set or you know its exact name — just call it. For a full permission-annotated dump use agent_tools:list.',
    chaining:
      'tools:find("<intent>") → call the top hit through tools:invoke in the SAME turn. `activated:true` ' +
      'means the server surface grew and requested a client refresh; it does not guarantee this client has ' +
      'materialized a direct-call wrapper yet. After a refresh/next turn, direct calls may work.',
    returns:
      '{ query, count, semantic: "on"|"warming"|"lexical-only", activated (were the hits added to YOUR live tool surface), hits: [{ tool, description, argSchema, returns (the tool\'s declared response shape, or null if it has not declared one), via }], howToCall }',
    seeAlso: [
      'agent_tools:list (full permission-annotated dump)',
      'meta:define-tool (define a new tool if none exists)',
    ],
  },
  capability: 'agent_tools:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // Discovery is the recovery door for locating diagnostics/restart tools when the
  // operator is degraded. The handler reads only the in-process tool catalog and
  // embedding index; retaining an ambient org-app transaction makes that recovery
  // door wait behind the very DB pool queue it is meant to diagnose.
  skipWorkspaceTx: true,
  args: z.object({
    /** What you want to do, in natural language or keywords. */
    query: z.string().min(1).max(400),
    /** Max results (default 8). */
    limit: z.number().int().positive().max(25).optional(),
  }),
  async handler(args, ctx) {
    const { corpus, embedText, returnsByTool } = buildCorpus();
    const embedder = await getEmbedder();
    // Self-heal: rebuild if boot warm didn't run or the catalog drifted. Non-
    // blocking — this call uses whatever index is ready right now.
    void ensureIndex(embedText, embedder);

    const hits = await findTools(corpus, args.query, {
      limit: args.limit ?? 8,
      embedder,
      embeddings: embIndex,
      // WI-20202755675039636: a resolved provider can still stall (notably an
      // OpenAI fetch without a client-side timeout); keep discovery responsive
      // by degrading this query to lexical-only at the interactive budget.
      embedTimeoutMs: interactiveEmbedAcquireBudgetMs(),
    });

    // Dynamic expansion (dynamic-tool-surface-2026-07-01): activate the matched
    // tools for THIS session so a seeded (small-surface) client can call them.
    // On a listChanged-capable transport this also fires tools/list_changed so
    // the client re-fetches tools/list and the surfaced tools become callable.
    // No-op (returns false) on a full-catalog / un-seeded session — nothing to
    // expand — and on transports without a mutable surface. NEVER let a surface
    // failure break discovery: the hits are still returned.
    let activated = false;
    try {
      activated = ctx.activateTools?.(hits.map((h) => h.tool)) ?? false;
    } catch {
      /* activation is best-effort; discovery still succeeds */
    }

    // Honest mode marker (never silently pretend semantic ran):
    //   on          — index ready, the semantic leg contributed;
    //   warming      — embedder configured, index still building (lexical-only this call);
    //   lexical-only — no embedder configured/available → graceful degrade.
    const semantic: 'on' | 'warming' | 'lexical-only' =
      embIndex != null && embIndex.size > 0 ? 'on' : embedder ? 'warming' : 'lexical-only';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            count: hits.length,
            semantic,
            // true ⇒ the server-side session allowlist grew and emitted the
            // standard list_changed request. It cannot prove the client has
            // consumed that notification and materialized wrappers yet.
            activated,
            hits: hits.map((h) => ({
              tool: h.tool,
              description: h.description,
              argSchema: h.argSchema,
              // EI-10882: the RESPONSE shape, so a caller can write a code:run
              // batch over this tool WITHOUT first calling it once just to learn
              // the field names. `null` is an honest "not declared" — call once and
              // inspect — never a silent omission the caller mistakes for "no body".
              returns: returnsByTool.get(h.tool) ?? null,
              via: h.via,
            })),
            // EI-10885: when activation did NOT happen, the old text still LED with
            // "Call the tool directly" — the one path that cannot work on this
            // surface — and relegated the path that always works to a fallback after
            // a failure. An agent that follows the instruction in order pays a
            // guaranteed wasted call. Lead with the working path instead.
            howToCall: activated
              ? 'activated:true means the SERVER surface grew and requested a client tool-list refresh; ' +
                'it does NOT guarantee your client has materialized a direct-call wrapper in this same turn. ' +
                'Call tools:invoke {name:"<exact tool name from hits>", args:{...}} now — it works immediately ' +
                'on every client via server-side dispatch. After the client refreshes (often next turn), the ' +
                'direct wrapper may also be available.'
              : 'activated:false — these tools are NOT on your live tool surface, so a direct call will ' +
                'fail with unknown/not-found. Call them with ' +
                'tools:invoke {name:"<exact tool name from hits>", args:{...}} — server-side dispatch under ' +
                "the tool's real (colon-form) name; works on every client, needs no load step. " +
                'Do NOT try ToolSearch on the colon name — it only resolves the client-mangled id.',
          }),
        },
      ],
    };
  },
});
