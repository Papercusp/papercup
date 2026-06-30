/**
 * tools:find — find tools by INTENT. The agent-facing front door to the
 * ~550-tool catalog (tool-discovery-for-weak-models-2026-06-30 WS3).
 *
 * Hybrid lexical + semantic search (the committed `cupboard/tool-find.ts`
 * floored-union core): the lexical leg is exact-name-authoritative, the semantic
 * leg broadens recall so "feature flag" finds `flags:*` and "spawn a worker"
 * finds `fleet:spawn` even with no shared words. Better than omp's keyword-only
 * `search_tool_bm25`, and — unlike that omp-internal search — usable by
 * claude/codex too.
 *
 * The semantic embedding index over the catalog is built LAZILY in the
 * background on first use (settings-driven embedder via `buildQueryEmbedder` —
 * currently openai), so the first call returns instant lexical results and the
 * index warms for subsequent calls. Every embedding path is wrapped to degrade
 * to lexical-only on any failure (no embedder, admission shed, fetch error), so
 * the tool is always functional.
 */
import { z } from 'zod';
import { defineTool, listAllProjectedTools, AGENT_ROLES } from '@papercusp/agent-mcp';
import { categoryOf } from '../../cupboard/tools-search';
import type { ToolDiscoveryEntry } from '../../cupboard/tools-discovery';
import { findTools, type Embedder } from '../../cupboard/tool-find';
import { buildQueryEmbedder } from '../search/embedder';

/** Build the live corpus from the projected-tool registry (name + description + guidance). */
function buildCorpus(): { corpus: ToolDiscoveryEntry[]; embedText: Map<string, string> } {
  const corpus: ToolDiscoveryEntry[] = [];
  const embedText = new Map<string, string>();
  for (const tool of listAllProjectedTools()) {
    if (!tool.expose.mcp) continue;
    const name = tool.expose.mcp.name;
    const when = tool.guidance?.when?.trim();
    // Fold the "when to use" line into the searchable text — it's the richest
    // intent signal for both legs (lexical description weight + the embedding).
    const description = [tool.description, when].filter(Boolean).join(' ').trim() || null;
    corpus.push({
      tool: name,
      category: categoryOf(name),
      capability: tool.capabilities[0] ?? null,
      description,
      provider: null,
      unit: null,
    } as unknown as ToolDiscoveryEntry);
    embedText.set(name, [name, tool.description, when].filter(Boolean).join('\n'));
  }
  return { corpus, embedText };
}

// ── Lazy, background-built embedding index (module-scoped cache) ──────────────
let queryEmbedder: Embedder | null | undefined; // undefined = not yet resolved
let embIndex: Map<string, number[]> | null = null;
let indexedCount = 0; // corpus size the index was built for (rebuild on drift)
let building = false;

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

/** Fire-and-forget: build the corpus embedding index once (or after catalog drift). */
function ensureIndexInBackground(embedText: Map<string, string>, embedder: Embedder | null): void {
  if (!embedder) return;
  if (embIndex && indexedCount === embedText.size) return; // fresh
  if (building) return;
  building = true;
  void (async () => {
    const next = new Map<string, number[]>();
    for (const [name, text] of embedText) {
      try {
        const v = await embedder(text);
        if (Array.isArray(v) && v.length > 0) next.set(name, v);
      } catch {
        /* skip this tool (admission shed / transient) — partial index still helps */
      }
    }
    embIndex = next;
    indexedCount = embedText.size;
    building = false;
  })().catch(() => {
    building = false;
  });
}

export default defineTool({
  name: 'tools:find',
  description:
    'Find tools by INTENT across the full ~550-tool catalog (hybrid lexical + semantic). ' +
    'Returns the best-matching tool names with descriptions. Use when you need a capability ' +
    'that is not in your core toolset — e.g. tools:find("feature flag") or tools:find("spawn a worker"). ' +
    'In omp, a returned tool is hidden behind discovery: load it with search_tool_bm25("<exact name>") before calling.',
  guidance: {
    when:
      'You need a tool that is not in your loaded/core set and you do not know its exact name — search by what you want to DO ' +
      '("set a feature flag", "list open plans", "spawn a worker bee"). The intent-aware replacement for guessing names.',
    notWhen:
      'When the tool is already in your core set or you know its exact name — just call it (in omp, search_tool_bm25("<name>") then call). ' +
      'For a full permission-annotated dump use agent_tools:list.',
    chaining:
      'tools:find("<intent>") → take the top tool name → (omp) search_tool_bm25("<name>") to load it → call it.',
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
  async handler(args) {
    const { corpus, embedText } = buildCorpus();
    const embedder = await getEmbedder();
    // Warm the semantic index in the background; this call uses whatever is ready
    // (lexical-only until the index finishes building the first time).
    ensureIndexInBackground(embedText, embedder);

    const hits = await findTools(corpus, args.query, {
      limit: args.limit ?? 8,
      embedder,
      embeddings: embIndex,
    });

    const semanticReady = embIndex != null && embIndex.size > 0;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            count: hits.length,
            semantic: semanticReady ? 'on' : building ? 'warming' : 'lexical-only',
            hits: hits.map((h) => ({
              tool: h.tool,
              description: h.description,
              via: h.via,
            })),
            howToCall:
              'In omp: search_tool_bm25("<tool name>") to load it, then call it. Claude/Codex: call it directly.',
          }),
        },
      ],
    };
  },
});
