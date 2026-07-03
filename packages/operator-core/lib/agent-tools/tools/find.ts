/**
 * tools:find — find tools by INTENT. The agent-facing front door to the
 * ~550-tool catalog (tool-discovery-for-weak-models-2026-06-30 WS3).
 *
 * Hybrid lexical + semantic search (the committed `cupboard/tool-find.ts`
 * floored-union core): the lexical leg is exact-name-authoritative, the semantic
 * leg broadens recall so "feature flag" finds `flags:*` and "spawn a worker"
 * finds `bee:spawn` even with no shared words. Better than omp's keyword-only
 * `search_tool_bm25`, and — unlike that omp-internal search — usable by
 * claude/codex too.
 *
 * The semantic embedding index over the catalog is built at BOOT
 * (`warmToolFindIndex`, fired once at module load) with a settings-driven
 * embedder via `buildQueryEmbedder` (currently openai, 384-d) — so the semantic
 * leg is live for the FIRST agent call rather than each cold worker warming
 * lazily on first use (where rate-governed 551-tool warming may never finish
 * before a call lands, leaving agents perpetually on lexical-only). It rebuilds
 * only on catalog size drift, and the handler self-heals (re-invokes the build)
 * if the boot warm hasn't completed. Every embedding path degrades to
 * lexical-only on any failure (no embedder, admission shed, fetch error) and the
 * result's `semantic` field reports which leg ran — so the tool is always
 * functional and never silently pretends semantic ran.
 */
import { z } from 'zod';
import { defineTool, listAllProjectedTools, AGENT_ROLES } from '@papercusp/agent-mcp';
import { categoryOf } from '../../cupboard/tools-search';
import { schemaToText, type ToolDiscoveryEntry } from '../../cupboard/tools-discovery';
import { findTools, type Embedder } from '../../cupboard/tool-find';
import { buildQueryEmbedder } from '../search/embedder';

/**
 * Build the live corpus from the projected-tool registry: name + description +
 * guidance.when + arg-schema text. The arg-schema text makes a tool's PARAMETERS
 * searchable/embeddable (so "set a flag by key" can match `flags:set`'s `key`
 * arg) and lets `tools:find` RETURN the schema with each hit. The embed text is
 * `name \n description \n when \n argSchema` — the richest intent signal for the
 * semantic leg.
 */
export function buildCorpus(): { corpus: ToolDiscoveryEntry[]; embedText: Map<string, string> } {
  const corpus: ToolDiscoveryEntry[] = [];
  const embedText = new Map<string, string>();
  for (const tool of listAllProjectedTools()) {
    if (!tool.expose.mcp) continue;
    const name = tool.expose.mcp.name;
    const when = tool.guidance?.when?.trim();
    const argSchema = schemaToText(tool.inputSchema);
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
  return { corpus, embedText };
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
      queryEmbedder = await buildQueryEmbedder();
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
    'Find tools by INTENT across the full ~550-tool catalog (hybrid lexical + semantic) AND ' +
    'activate the matches for your session so you can call them. Returns the best-matching tool ' +
    'names with descriptions. Use when you need a capability that is not in your core toolset — ' +
    'e.g. tools:find("feature flag") or tools:find("spawn a worker"). On a seeded (small-surface) ' +
    'session the matched tools are added to your live tool list on the fly, so after this call you ' +
    'can call the one you want directly.',
  guidance: {
    when:
      'You need a tool that is not in your loaded/core set and you do not know its exact name — search by what you want to DO ' +
      '("set a feature flag", "list open plans", "spawn a worker bee"). The intent-aware replacement for guessing names.',
    notWhen:
      'When the tool is already in your core set or you know its exact name — just call it (in omp, if a direct call reports not-found, tools:invoke {name, args} runs it server-side). ' +
      'For a full permission-annotated dump use agent_tools:list.',
    chaining:
      'tools:find("<intent>") activates the matches for your session → call the top tool directly. ' +
      'If the direct call errors "tool not found", do NOT guess name variants: call ' +
      'tools:invoke {name:"<tool>", args:{...}} — it runs any catalog tool without loading. ' +
      'tools:invoke works on every client (claude/codex/omp) and never needs a separate load step.',
    seeAlso: [
      'agent_tools:list (full permission-annotated dump)',
      'meta:define-tool (define a new tool if none exists)',
    ],
  },
  capability: 'agent_tools:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    /** What you want to do, in natural language or keywords. */
    query: z.string().min(1).max(400),
    /** Max results (default 8). */
    limit: z.number().int().positive().max(25).optional(),
  }),
  async handler(args, ctx) {
    const { corpus, embedText } = buildCorpus();
    const embedder = await getEmbedder();
    // Self-heal: rebuild if boot warm didn't run or the catalog drifted. Non-
    // blocking — this call uses whatever index is ready right now.
    void ensureIndex(embedText, embedder);

    const hits = await findTools(corpus, args.query, {
      limit: args.limit ?? 8,
      embedder,
      embeddings: embIndex,
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
            // true ⇒ the matches were added to your live tool surface this call
            // (a seeded session); call the one you want directly next.
            activated,
            hits: hits.map((h) => ({
              tool: h.tool,
              description: h.description,
              argSchema: h.argSchema,
              via: h.via,
            })),
            howToCall: activated
              ? 'The matched tools are now active for your session — call the one you want directly. ' +
                'If that errors "tool not found", do NOT guess name variants: call ' +
                'tools:invoke {name:"<exact tool name from hits>", args:{...}} — it runs any catalog tool ' +
                'without loading. tools:invoke works on every client including omp (server-side dispatch).'
              : 'Call the tool directly (Claude/Codex). If it reports unknown/not-found, call ' +
                'tools:invoke {name:"<exact tool name from hits>", args:{...}} — always works, on every ' +
                'client including omp (server-side dispatch; no load step).',
          }),
        },
      ],
    };
  },
});
