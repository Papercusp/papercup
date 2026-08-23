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
import {
  AGENT_ROLES,
  PROJECTED_TOOL_REGISTRY_SOURCE,
  defineTool,
  listAllProjectedTools,
  projectedToolRegistryRevision,
} from '@papercusp/agent-mcp';
import { categoryOf } from '../../cupboard/tools-search';
import { arrayItemConstraintText, schemaToText, type ToolDiscoveryEntry } from '../../cupboard/tools-discovery';
import { findTools, type Embedder } from '../../cupboard/tool-find';
import { buildQueryEmbedder, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { resolveConcreteHarnessSlug } from '../_harness-scope';

/**
 * The result-door is a per-tool-result budget, not a per-field budget. A
 * discovery hit can therefore be perfectly valid in isolation and still make
 * the whole `tools:find` response unparseable when several hits carry verbose
 * schemas. Keep the ranking corpus rich, but project the response through a
 * compact structural schema and a conservative byte budget.
 */
export const DISCOVERY_RESULT_MAX_BYTES = 5_000;
const DISCOVERY_DESCRIPTION_MAX_CHARS = 320;
const DISCOVERY_SCHEMA_MAX_CHARS = 2_200;
const COMPACT_NESTED_DESCRIPTION_MAX_CHARS = 180;

type JsonSchemaNode = {
  type?: unknown;
  enum?: unknown;
  const?: unknown;
  pattern?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
};

function schemaNodes(node: JsonSchemaNode): JsonSchemaNode[] {
  const unions = [node.anyOf, node.oneOf].find(Array.isArray);
  const branches = unions
    ? (unions as unknown[]).filter((n): n is JsonSchemaNode => !!n && typeof n === 'object')
    : [];

  // Some strict Zod schemas deliberately include permissive branches solely so
  // `superRefine` can replace their generic error with teaching text.  Those
  // branches are still present in the generated JSON Schema even though the
  // handler rejects them: shapeTaughtArray, for example, emits a bounded strict
  // array alongside a bare string and an untyped `array` catch-all.  Returning
  // those branches from discovery tells callers that an invalid value is
  // callable (`array|string`) and hides the fact that the nested object fields
  // are the accepted shape.  The compact projection should describe the
  // callable branch, not the validation-only refusal branches.
  const hasTeachingArrayShape = branches.some((branch) =>
    branch.type === 'array' && (branch.minItems != null || branch.maxItems != null),
  );
  if (!hasTeachingArrayShape) return branches;

  const isBareString = (branch: JsonSchemaNode): boolean =>
    branch.type === 'string' && Object.keys(branch).every((key) => key === 'type' || key === 'description');
  const isUntypedArrayCatchall = (branch: JsonSchemaNode): boolean => {
    if (branch.type !== 'array' || branch.minItems != null || branch.maxItems != null) return false;
    if (!branch.items || typeof branch.items !== 'object' || Array.isArray(branch.items)) return false;
    return Object.keys(branch.items as Record<string, unknown>).every((key) => key === 'description');
  };
  const callableBranches = branches.filter((branch) => !isBareString(branch) && !isUntypedArrayCatchall(branch));
  return callableBranches.length > 0 ? callableBranches : branches;
}

function schemaType(node: JsonSchemaNode): string {
  const enumValues = Array.isArray(node.enum)
    ? node.enum.filter((v): v is string | number | boolean =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      )
    : [];
  if (enumValues.length > 0) return `enum(${enumValues.join('|')})`;
  // z.literal() emits JSON Schema's `const`, not `enum`. Preserve that
  // singleton constraint in discovery so callers do not learn the accepted
  // value only after a runtime rejection (EI-21166891721391042).
  if (
    Object.prototype.hasOwnProperty.call(node, 'const') &&
    (node.const === null ||
      typeof node.const === 'string' ||
      typeof node.const === 'number' ||
      typeof node.const === 'boolean')
  ) {
    return `enum(${String(node.const)})`;
  }
  if (typeof node.type === 'string') return node.type;
  const unionTypes = [...new Set(schemaNodes(node).map(schemaType).filter(Boolean))];
  return unionTypes.join('|');
}

function schemaBound(node: JsonSchemaNode): string {
  const nodes = [node, ...schemaNodes(node)];
  const numberValue = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const lower = nodes
    .map((n) =>
      numberValue(n.minimum) ??
      numberValue(n.exclusiveMinimum) ??
      numberValue(n.minLength) ??
      numberValue(n.minItems),
    )
    .find((value): value is number => value != null);
  const upper = nodes
    .map((n) =>
      numberValue(n.maximum) ??
      numberValue(n.exclusiveMaximum) ??
      numberValue(n.maxLength) ??
      numberValue(n.maxItems),
    )
    .find((value): value is number => value != null);
  return lower != null && upper != null
    ? `(${lower}-${upper})`
    : upper != null
      ? `(≤${upper})`
      : lower != null
        ? `(≥${lower})`
        : '';
}

function schemaPattern(node: JsonSchemaNode): string {
  const pattern = [node, ...schemaNodes(node)]
    .map((candidate) => (typeof candidate.pattern === 'string' && candidate.pattern.length > 0 ? candidate.pattern : null))
    .find((value): value is string => value != null);
  return pattern ? `~/${pattern}/` : '';
}

function objectProperties(node: JsonSchemaNode): { properties: Record<string, unknown>; required: Set<string> } | null {
  const candidates = [node, ...schemaNodes(node)];
  for (const candidate of candidates) {
    if (!candidate.properties || typeof candidate.properties !== 'object' || Array.isArray(candidate.properties)) continue;
    const required = new Set<string>(Array.isArray(candidate.required) ? candidate.required.filter((v): v is string => typeof v === 'string') : []);
    return { properties: candidate.properties as Record<string, unknown>, required };
  }
  return null;
}

/** Keep the compact result useful without letting recursive schemas consume it. */
const MAX_NESTED_SCHEMA_DEPTH = 4;

function nestedObjectProperties(node: JsonSchemaNode): { properties: Record<string, unknown>; required: Set<string> } | null {
  const direct = objectProperties(node);
  if (direct) return direct;

  for (const candidate of [node, ...schemaNodes(node)]) {
    if (!candidate.items || typeof candidate.items !== 'object' || Array.isArray(candidate.items)) continue;
    const item = objectProperties(candidate.items as JsonSchemaNode);
    if (item) return item;
  }
  return null;
}

function nestedFieldNames(node: JsonSchemaNode, depth: number): string {
  if (depth >= MAX_NESTED_SCHEMA_DEPTH) return '';
  const nested = nestedObjectProperties(node);
  if (!nested) return '';
  const names = Object.entries(nested.properties).map(([name, raw]) => {
    const child = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonSchemaNode : {};
    const shape = schemaShape(child, depth);
    const description = nestedDescription(child, depth);
    return `${name}${nested.required.has(name) ? '' : '?'}${shape ? `:${shape}` : ''}${description}`;
  });
  return names.length > 0 ? `{${names.join(',')}}` : '';
}

/**
 * Keep semantic descriptions for nested fields that cannot be represented by
 * JSON Schema structure alone (for example, a pipeline must be the sanitized
 * integration-root basename). Top-level descriptions remain on the tool hit;
 * nested descriptions are otherwise lost by the compact projection. Bound the
 * hint so one verbose field cannot consume the discovery result budget.
 */
function nestedDescription(node: JsonSchemaNode, depth: number): string {
  if (depth <= 0 || typeof node.description !== 'string') return '';
  const description = node.description.replace(/\s+/g, ' ').trim();
  if (!description) return '';
  const bounded = description.length <= COMPACT_NESTED_DESCRIPTION_MAX_CHARS
    ? description
    : `${description.slice(0, COMPACT_NESTED_DESCRIPTION_MAX_CHARS - 1)}…`;
  return ` ${bounded}`;
}

function schemaShape(node: JsonSchemaNode, depth: number): string {
  const type = schemaType(node);
  const bound = schemaBound(node);
  // Keep regex constraints in the returned schema just as bounds and array
  // item constraints are kept. Without this, tools:find's response path
  // silently downgraded locks:release's published_sha to bare `string`, even
  // though the searchable corpus already exposed the pattern.
  const pattern = type.startsWith('enum(') ? '' : schemaPattern(node);
  const itemConstraint = [node, ...schemaNodes(node)]
    .map((candidate) => arrayItemConstraintText(candidate))
    .find((text): text is string => text.length > 0) ?? '';
  const nested = nestedFieldNames(node, depth + 1);
  return `${type}${bound}${pattern}${itemConstraint}${nested}`;
}

/**
 * Render only the structural part of a JSON schema for the returned hit. The
 * full descriptions remain in the search corpus; this projection is what a
 * caller needs to form a valid next call without overflowing the result door.
 */
export function compactSchemaForResult(inputSchema: unknown): string | null {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  const root = inputSchema as JsonSchemaNode;
  const props = root.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const required = new Set<string>(Array.isArray(root.required) ? root.required.filter((v): v is string => typeof v === 'string') : []);
  const parts = Object.entries(props as Record<string, unknown>).map(([name, raw]) => {
    const node = raw && typeof raw === 'object' ? raw as JsonSchemaNode : {};
    const shape = schemaShape(node, 0);
    return `${name}${required.has(name) ? '' : '?'}${shape ? `:${shape}` : ''}`;
  });
  if (parts.length === 0) return null;
  const text = parts.join('; ');
  return text.length <= DISCOVERY_SCHEMA_MAX_CHARS
    ? text
    : `${text.slice(0, DISCOVERY_SCHEMA_MAX_CHARS - 1)}…`;
}

function boundedText(value: string | null, maxChars: number): string | null {
  if (value == null || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

export interface DiscoveryResultHit {
  tool: string;
  description: string | null;
  argSchema: string | null;
  via: string;
}

/** Keep the result valid and useful when the caller asks for many hits. */
export function boundDiscoveryHits(
  base: Omit<Record<string, unknown>, 'hits' | 'count' | 'truncated'>,
  hits: DiscoveryResultHit[],
): { hits: DiscoveryResultHit[]; truncated: boolean } {
  const kept: DiscoveryResultHit[] = [];
  for (const hit of hits) {
    const candidate = [...kept, hit];
    const projected = {
      ...base,
      count: candidate.length,
      totalMatches: hits.length,
      truncated: candidate.length < hits.length,
      hits: candidate,
    };
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > DISCOVERY_RESULT_MAX_BYTES && kept.length > 0) break;
    kept.push(hit);
  }
  return { hits: kept, truncated: kept.length < hits.length };
}

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
  /** name → raw schema, used to project a compact schema in the response. */
  schemaByTool: Map<string, unknown>;
} {
  const corpus: ToolDiscoveryEntry[] = [];
  const embedText = new Map<string, string>();
  const returnsByTool = new Map<string, string>();
  const schemaByTool = new Map<string, unknown>();
  for (const tool of listAllProjectedTools()) {
    if (!tool.expose.mcp) continue;
    const name = tool.expose.mcp.name;
    const when = tool.guidance?.when?.trim();
    // Strict MCP/OpenAI callers receive the flattened schema, but discovery
    // needs the raw union so branch requirements (for example path OR sha)
    // remain visible. Older/plugin projections may not expose the raw field,
    // so retain the flattened fallback.
    const discoverySchema = tool.discoveryInputSchema ?? tool.inputSchema;
    const argSchema = schemaToText(discoverySchema);
    const returns = (tool.guidance as { returns?: string } | undefined)?.returns?.trim();
    if (returns) returnsByTool.set(name, returns);
    schemaByTool.set(name, discoverySchema);
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
  return { corpus, embedText, returnsByTool, schemaByTool };
}

type DiscoveryScopeContext = {
  workspaceId?: unknown;
  harnessSlug?: unknown;
};

type HiveHomeResolver = (workspaceId: string, harnessSlug: string) => Promise<string | null>;

/**
 * Mirror the transport's confirmed hive visibility before ranking. A
 * hive-scoped superuser cannot call `cross_harness:*`, so leaving those rows in
 * the discovery corpus can spend a narrow result (especially `limit: 1`) on a
 * tool the same request path must reject. Resolution is deliberately fail-open:
 * only a concrete, positively resolved hive scope removes catalog entries.
 */
export async function filterCorpusForConfirmedHiveScope(
  corpus: ToolDiscoveryEntry[],
  scope: DiscoveryScopeContext,
  resolveHiveHome: HiveHomeResolver,
): Promise<ToolDiscoveryEntry[]> {
  const workspaceId = typeof scope.workspaceId === 'string' ? scope.workspaceId.trim() : '';
  const harnessSlug = typeof scope.harnessSlug === 'string' ? scope.harnessSlug.trim() : '';
  if (
    !workspaceId ||
    workspaceId === '*' ||
    workspaceId === 'all' ||
    !harnessSlug ||
    harnessSlug === '*' ||
    harnessSlug === 'all'
  ) {
    return corpus;
  }

  let hiveHome: string | null;
  try {
    hiveHome = await resolveHiveHome(workspaceId, harnessSlug);
  } catch {
    return corpus;
  }
  if (!hiveHome) return corpus;

  return corpus.filter((entry) => !entry.tool.startsWith('cross_harness:'));
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
    'its field names. ACTIVATION IS ' +
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
      '{ query, count, semantic: "on"|"warming"|"lexical-only", registry: { source, revision }, activated (were the hits added to YOUR live tool surface), hits: [{ tool, description, argSchema, returns (the tool\'s declared response shape, or null if it has not declared one), via }], howToCall }',
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
    const registry = {
      source: PROJECTED_TOOL_REGISTRY_SOURCE,
      revision: projectedToolRegistryRevision(),
    };
    const { corpus: fullCorpus, embedText, schemaByTool } = buildCorpus();
    const concreteHarnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
    const corpus = await filterCorpusForConfirmedHiveScope(
      fullCorpus,
      { workspaceId: ctx.workspaceId, harnessSlug: concreteHarnessSlug },
      async (workspaceId, harnessSlug) => {
        const { potHomeSlugForHarness } = await import('../../hive-federation');
        return potHomeSlugForHarness(workspaceId, harnessSlug);
      },
    );
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
    const projectedHits = hits.map((h) => ({
      tool: h.tool,
      description: boundedText(h.description, DISCOVERY_DESCRIPTION_MAX_CHARS),
      argSchema: compactSchemaForResult(schemaByTool.get(h.tool)) ?? boundedText(h.argSchema, DISCOVERY_SCHEMA_MAX_CHARS),
      via: h.via,
    }));
    const howToCall = activated
      ? 'activated:true means the SERVER surface grew and requested a client tool-list refresh; ' +
        'it does NOT guarantee your client has materialized a direct-call wrapper in this same turn. ' +
        'Call tools:invoke {name:"<exact tool name from hits>", args:{...}} now — it works immediately ' +
        'on every client via server-side dispatch. After the client refreshes (often next turn), the ' +
        'direct wrapper may also be available.'
      : 'activated:false — these tools are NOT on your live tool surface, so a direct call will ' +
        'fail with unknown/not-found. Call them with ' +
        'tools:invoke {name:"<exact tool name from hits>", args:{...}} — server-side dispatch under ' +
        "the tool's real (colon-form) name; works on every client, needs no load step. " +
        'Do NOT try ToolSearch on the colon name — it only resolves the client-mangled id.';
    const bounded = boundDiscoveryHits(
      { query: args.query, semantic, registry, activated, howToCall, totalMatches: hits.length },
      projectedHits,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            count: bounded.hits.length,
            totalMatches: hits.length,
            truncated: bounded.truncated,
            semantic,
            registry,
            // true ⇒ the server-side session allowlist grew and emitted the
            // standard list_changed request. It cannot prove the client has
            // consumed that notification and materialized wrappers yet.
            activated,
            hits: bounded.hits,
            // EI-10885: when activation did NOT happen, the old text still LED with
            // "Call the tool directly" — the one path that cannot work on this
            // surface — and relegated the path that always works to a fallback after
            // a failure. An agent that follows the instruction in order pays a
            // guaranteed wasted call. Lead with the working path instead.
            howToCall,
          }),
        },
      ],
    };
  },
});
