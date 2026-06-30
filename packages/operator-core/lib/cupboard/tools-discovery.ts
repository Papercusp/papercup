/**
 * tools-discovery — project the derived pack catalog into the marketplace's
 * **Tools section** payload (`tool-distribution-granularity-2026-06-05`
 * P-006 / D-002/D-005).
 *
 * The discovery question is the resolver's question, fanned out: *for every
 * known tool, who provides it?* Each entry is one tool name resolved through
 * the `resolveToolProvider` ladder:
 *
 *   - `available`   — usable right now (built-in catalog, or an installed
 *                     plugin/pack registered it);
 *   - `installable` — a Cupboard listing (kind plugin|pack) declares it in
 *                     `provides_tools`; installing that unit resolves it. The
 *                     entry carries the providing listing so the UI can offer
 *                     the install action (D-005: a tool resolves to its
 *                     providing unit — runtime-sharing tools never install in
 *                     isolation).
 *
 * Pure projection over a `DerivedPackCatalog` — the route handler does the IO
 * (`derivePackCatalog()`) and delegates here, so this is unit-testable with
 * `assemblePackCatalog`-built inputs.
 */
import { resolveToolProvider, type PackDescriptor } from '@papercusp/blueprint-distribution';
import { getCatalog, listAllProjectedTools } from '@papercusp/agent-mcp';
import type { DerivedPackCatalog } from './pack-catalog';
import { categoryOf, searchTools } from './tools-search';

export interface ToolDiscoveryEntry {
  /** The MCP tool name (e.g. `repomix.pack`, `coord:send`). */
  tool: string;
  status: 'available' | 'installable';
  /** Namespace prefix used as the discovery category (`coord:send` → `coord`). */
  category: string;
  /**
   * One-line capability description — the tool's own (built-ins/installed
   * plugin tools) or, for a Cupboard-only tool with no per-tool text, the
   * providing unit's. Drives capability search + the UI's description line.
   */
  description?: string | null;
  /**
   * Compact, human-readable arg-schema text derived from the tool's JSON
   * inputSchema (`key:type description; …`). Makes argument names + their docs
   * searchable (lexical + embedding legs) and returnable by `tools:find`, so an
   * intent query can match on what a tool's PARAMETERS are, not just its name.
   * Null when the tool takes no args or the schema is absent.
   */
  argSchema?: string | null;
  /** The capability gate string (e.g. `tasks:read`), for built-ins. */
  capability?: string | null;
  /** Who provides it (the resolver's answer). */
  provider: {
    kind: 'builtin' | 'plugin' | 'pack';
    name: string;
    /** Cupboard listing id, when the provider is an installable listing. */
    listingId?: string | null;
  };
  /**
   * The providing distribution unit's descriptor surface (absent for
   * built-ins, which belong to no unit). Drives the UI's unit line +
   * install action.
   */
  unit?: {
    name: string;
    kind: 'plugin' | 'pack';
    source: 'installed' | 'cupboard';
    description?: string | null;
    version?: string | null;
    listingId?: string | null;
  };
}

/** One category facet: a namespace + how many matched tools fall under it. */
export interface CategoryFacet {
  name: string;
  count: number;
}

export interface ToolsDiscoveryPayload {
  tools: ToolDiscoveryEntry[];
  counts: { available: number; installable: number };
  /** Category facets over the searched/status-filtered set (pre category-filter). */
  categories: CategoryFacet[];
  /** False when the Cupboard fetch failed — the UI shows a degraded banner. */
  cupboardReachable: boolean;
}

export interface ToolsDiscoveryFilters {
  /** Capability search — relevance-ranks by name/category/capability/provider/description. */
  q?: string;
  /** Narrow to one resolution status. */
  status?: 'available' | 'installable';
  /** Narrow to one category (namespace). */
  category?: string;
}

/**
 * Per-tool capability text + gate, keyed by tool name. Built from the live
 * registries by `collectToolMeta()`; injected into the pure builders so they
 * stay unit-testable. Cupboard-only tools (names with no local registration)
 * are absent — they fall back to the providing unit's description.
 */
export type ToolMetaIndex = Map<
  string,
  { description?: string | null; capability?: string | null; argSchema?: string | null }
>;

/**
 * Render a tool's JSON inputSchema into one compact searchable/embeddable line:
 * `key:type description; otherKey?:enum …` (a `?` marks an optional property).
 * Pulls only the model-facing surface — property names, their `type` (or `enum`),
 * and their `description` — so the arg vocabulary feeds both search legs without
 * dragging the raw JSON Schema into the corpus. Null for a no-arg / absent /
 * non-object schema.
 */
export function schemaToText(inputSchema: unknown): string | null {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  const props = (inputSchema as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return null;
  const requiredRaw = (inputSchema as { required?: unknown }).required;
  const required = new Set<string>(Array.isArray(requiredRaw) ? (requiredRaw as string[]) : []);
  const parts: string[] = [];
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as {
      description?: unknown;
      type?: unknown;
      enum?: unknown;
    };
    const type =
      typeof p.type === 'string' ? p.type : Array.isArray(p.enum) ? 'enum' : '';
    const desc = typeof p.description === 'string' ? p.description.trim() : '';
    const head = `${name}${required.has(name) ? '' : '?'}${type ? `:${type}` : ''}`;
    parts.push(desc ? `${head} ${desc}` : head);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

function unitOf(pack: PackDescriptor): ToolDiscoveryEntry['unit'] {
  return {
    name: pack.name,
    kind: pack.kind,
    source: pack.source,
    description: pack.description ?? null,
    version: pack.version ?? null,
    listingId: pack.listingId ?? null,
  };
}

/**
 * Resolve every tool name the catalog knows into an enriched
 * `ToolDiscoveryEntry` (provider + category + description + capability). No
 * filtering or sorting — the shared substrate for both the Tools view
 * (`buildToolsDiscovery`) and the "what provides X" surface
 * (`buildToolProvenance`).
 */
export function resolveToolEntries(
  cat: DerivedPackCatalog,
  meta?: ToolMetaIndex,
): ToolDiscoveryEntry[] {
  const names = new Set<string>(cat.builtinTools);
  for (const t of cat.view.installedToolIndex.keys()) names.add(t);
  for (const t of cat.view.cupboardToolIndex.keys()) names.add(t);

  const entries: ToolDiscoveryEntry[] = [];
  for (const tool of names) {
    const res = resolveToolProvider(tool, cat.view);
    if (res.status === 'unknown') continue; // unreachable: names come from the view
    const entry: ToolDiscoveryEntry = {
      tool,
      status: res.status,
      category: categoryOf(tool),
      provider: { ...res.provider },
    };
    if (res.provider.kind !== 'builtin') {
      const pack = cat.view.byName.get(res.provider.name);
      if (pack) entry.unit = unitOf(pack);
    }
    const m = meta?.get(tool);
    entry.description = m?.description ?? entry.unit?.description ?? null;
    entry.capability = m?.capability ?? null;
    entry.argSchema = m?.argSchema ?? null;
    entries.push(entry);
  }
  return entries;
}

/**
 * Every tool the catalog knows, resolved → status-filtered → capability-ranked
 * (when `q` is set) or name-sorted (browse) → category-faceted →
 * category-filtered. The facets are computed over the searched/status-filtered
 * set *before* the category narrow, so a UI can switch categories within the
 * current search.
 */
export function buildToolsDiscovery(
  cat: DerivedPackCatalog,
  filters: ToolsDiscoveryFilters = {},
  meta?: ToolMetaIndex,
): ToolsDiscoveryPayload {
  let entries = resolveToolEntries(cat, meta);
  if (filters.status) entries = entries.filter((e) => e.status === filters.status);

  // Capability search ranks; an absent query is the neutral name-sorted browse.
  const q = filters.q?.trim();
  entries = q ? searchTools(entries, q) : entries.sort((a, b) => a.tool.localeCompare(b.tool));

  // Facets over the searched/status set, pre category-filter.
  const facetCounts = new Map<string, number>();
  for (const e of entries) facetCounts.set(e.category, (facetCounts.get(e.category) ?? 0) + 1);
  const categories: CategoryFacet[] = [...facetCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  if (filters.category) {
    const want = filters.category.toLowerCase();
    entries = entries.filter((e) => e.category === want);
  }

  let available = 0;
  let installable = 0;
  for (const e of entries) {
    if (e.status === 'available') available += 1;
    else installable += 1;
  }

  return { tools: entries, counts: { available, installable }, categories, cupboardReachable: cat.cupboardReachable };
}

/** "What provides X" — the human-facing inverse of the dep resolver (P-006). */
export interface ToolProvenancePayload {
  /** The query that was resolved (the `tool` name or the `q` capability phrase). */
  query: string;
  /**
   * Exact-name resolution: the entry whose tool name == `tool`, if known.
   * `null` for a capability (`q`) query or an unknown name.
   */
  resolved: ToolDiscoveryEntry | null;
  /**
   * Ranked candidate providers (capability search). Each installable match
   * carries `provider.listingId` + `unit` — that *is* the install action. The
   * exact resolution, when present, always leads.
   */
  matches: ToolDiscoveryEntry[];
  cupboardReachable: boolean;
}

/**
 * Given a tool name (`tool`, exact) or a capability phrase (`q`), return the
 * providing unit(s) + install action — the inverse of the dependency resolver
 * (it asks "what installs this declared tool?"; this asks "I want capability
 * X, what provides it?"). `tool` takes precedence; `q` is the fallback query.
 */
export function buildToolProvenance(
  cat: DerivedPackCatalog,
  opts: { tool?: string; q?: string },
  meta?: ToolMetaIndex,
): ToolProvenancePayload {
  const entries = resolveToolEntries(cat, meta);
  const query = (opts.tool ?? opts.q ?? '').trim();
  const resolved = opts.tool ? entries.find((e) => e.tool === opts.tool) ?? null : null;
  const ranked = searchTools(entries, query);
  const matches = resolved
    ? [resolved, ...ranked.filter((e) => e.tool !== resolved.tool)]
    : ranked;
  return { query, resolved, matches, cupboardReachable: cat.cupboardReachable };
}

/**
 * Build the per-tool capability index from the LIVE registries: the legacy
 * catalog (`getCatalog()` — built-ins, with description + capability gate) and
 * the projected-tool registry (`listAllProjectedTools()` — adds installed
 * plugin/pack tools, description only). Built-ins win on name collision (they
 * carry the capability gate). Not pure — the route calls this and injects the
 * result into the pure builders above.
 */
export function collectToolMeta(): ToolMetaIndex {
  const meta: ToolMetaIndex = new Map();
  for (const t of getCatalog()) {
    meta.set(t.name, { description: t.description ?? null, capability: t.capability ?? null });
  }
  // The projected mirror carries the ready-made JSON `inputSchema` (the legacy
  // catalog only holds the un-rendered zod validator), so arg-schema text is
  // sourced here — ENRICHING the built-in entries above with their `argSchema`
  // AND adding projected-only (installed plugin) tools.
  for (const t of listAllProjectedTools()) {
    const name = t.expose?.mcp?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const argSchema = schemaToText(t.inputSchema);
    const existing = meta.get(name);
    if (existing) existing.argSchema = argSchema; // built-in: keep its capability gate
    else meta.set(name, { description: t.description ?? null, capability: null, argSchema });
  }
  return meta;
}
