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
 * One level of a nested `object`-typed property's own `properties` — just the
 * field names (marking required-if-present ones), e.g. `{max_sec}` or
 * `{file,old_string,new_string?}`. Not recursive (one level is enough to name
 * the fields a caller needs; a deeper nest still falls back to bare `object`).
 * Empty/non-object nested schemas render nothing.
 */
function objectFieldsText(schema: { properties?: unknown; required?: unknown }): string {
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return '';
  const nestedRequired = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const names = Object.keys(schema.properties as Record<string, unknown>).map(
    (n) => `${n}${nestedRequired.has(n) ? '' : '?'}`,
  );
  return names.join(',');
}

function nestedObjectFieldsText(p: {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
}): string {
  if (p.type !== 'object') return '';
  const direct = objectFieldsText(p);
  if (direct) return `{${direct}}`;

  // z.record() advertises the entry schema under additionalProperties rather
  // than properties. Keep the map nature visible so callers do not mistake a
  // record of typed entries for a free-form object.
  if (
    p.additionalProperties &&
    typeof p.additionalProperties === 'object' &&
    !Array.isArray(p.additionalProperties)
  ) {
    const valueSchema = p.additionalProperties as { type?: unknown; properties?: unknown; required?: unknown };
    if (valueSchema.type === 'object') {
      const valueFields = objectFieldsText(valueSchema);
      if (valueFields) return `{*:object{${valueFields}}}`;
    }
  }
  return '';
}

/**
 * Render a caller-facing constraint declared on an array's primitive item
 * schema. JSON Schema nests these under `items`, so looking only at the array
 * node loses the constraint (for example plans:add-decision's `refs` pattern).
 */
export function arrayItemConstraintText(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const node = input as { type?: unknown; items?: unknown };
  if (node.type !== 'array' || !node.items || typeof node.items !== 'object' || Array.isArray(node.items)) return '';
  const item = node.items as { type?: unknown; enum?: unknown; pattern?: unknown };
  const enumValues = Array.isArray(item.enum)
    ? item.enum.filter((v): v is string | number | boolean =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      )
    : [];
  if (enumValues.length > 0) return `<enum(${enumValues.join('|')})>`;
  const pattern = typeof item.pattern === 'string' && item.pattern.length > 0 ? item.pattern : '';
  if (!pattern) return '';
  const itemType = typeof item.type === 'string' ? item.type : 'string';
  return `<${itemType}~/${pattern}/>`;
}

/**
 * Render a tool's JSON inputSchema into one compact searchable/embeddable line:
 * `key:type description; otherKey?:enum …` (a `?` marks an optional property).
 * Pulls only the model-facing surface — property names, their `type` (or `enum`),
 * and their `description` — so the arg vocabulary feeds both search legs without
 * dragging the raw JSON Schema into the corpus. Null for a no-arg / absent /
 * non-object schema.
 *
 * EI-13190: an `object`-typed property (e.g. `wait: { max_sec }`) used to render
 * as bare `wait?:object` — the nested REQUIRED field name (`max_sec`) was
 * invisible until a call guessing a different name (`timeout_ms`) was rejected,
 * and only the rejection error revealed the real name. Every such property now
 * also gets its one-level nested field-name list appended, e.g. `wait?:object{max_sec}`,
 * so the required nested shape is visible at discovery time, not just on retry.
 */
export function schemaToText(inputSchema: unknown): string | null {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  const root = inputSchema as Record<string, unknown>;
  const directProps = root.properties;
  const rawBranches = Array.isArray(root.anyOf)
    ? root.anyOf
    : Array.isArray(root.oneOf)
      ? root.oneOf
      : [];
  const branches = (directProps && typeof directProps === 'object' && !Array.isArray(directProps)
    ? [root]
    : rawBranches
  ).filter((branch): branch is Record<string, unknown> => !!branch && typeof branch === 'object' && !Array.isArray(branch));
  if (branches.length === 0) return null;

  // A raw union can require different top-level keys in each branch. Merge
  // the fields for searchable text, but mark a field required only when it is
  // present and required in every branch. The branch-required names remain in
  // the prefix so callers can see the OR constraint instead of inferring that
  // the flattened optional view is the whole contract.
  const merged = new Map<string, { raw: unknown; presentIn: number; requiredInAll: boolean }>();
  for (const branch of branches) {
    const props = branch.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) continue;
    const requiredRaw = branch.required;
    const required = new Set<string>(Array.isArray(requiredRaw) ? requiredRaw.filter((v): v is string => typeof v === 'string') : []);
    for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
      const prior = merged.get(name);
      if (prior) {
        prior.presentIn += 1;
        prior.requiredInAll = prior.requiredInAll && required.has(name);
      } else {
        merged.set(name, { raw, presentIn: 1, requiredInAll: required.has(name) });
      }
    }
  }
  if (merged.size === 0) return null;

  const unionHint = branches.length > 1
    ? branches
      .map((branch) => Array.isArray(branch.required)
        ? branch.required.filter((v): v is string => typeof v === 'string')
        : [])
      .filter((names) => names.length > 0)
      .map((names) => names.join('&'))
      .join('|')
    : '';
  const parts: string[] = [];
  for (const [name, entry] of merged) {
    const raw = entry.raw;
    const p = (raw && typeof raw === 'object' ? raw : {}) as {
      description?: unknown;
      type?: unknown;
      enum?: unknown;
      const?: unknown;
      properties?: unknown;
      required?: unknown;
      minimum?: unknown;
      maximum?: unknown;
      exclusiveMinimum?: unknown;
      exclusiveMaximum?: unknown;
      minLength?: unknown;
      maxLength?: unknown;
      minItems?: unknown;
      maxItems?: unknown;
      items?: unknown;
      pattern?: unknown;
    };
    // EI-13164: an `enum` property's JSON-schema output ALSO carries `type:"string"`
    // (zod's own toJSONSchema emits both for `z.enum([...])`, confirmed for
    // `severity: z.enum(['critical','major','minor','nit'])` → `{ type:"string",
    // enum:[...] }`) — so the `type` branch below fired first and the enum branch
    // was DEAD CODE for every real zod enum, silently downgrading the discovered
    // shape to a bare `:string`. A caller then had no way to learn the allowed
    // values short of a rejected write (tools:find showed `severity?:string`;
    // passing a plausible-but-wrong value like "low" surfaced the real
    // critical|major|minor|nit set only in the runtime error). Check enum FIRST,
    // and render its actual member values (not just the word "enum") — strictly
    // more informative than either the old enum-only or type-only text.
    const enumValues = Array.isArray(p.enum)
      ? (p.enum as unknown[]).filter((v): v is string | number | boolean | null =>
          v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        )
      : Object.prototype.hasOwnProperty.call(p, 'const') &&
          (p.const === null ||
            typeof p.const === 'string' ||
            typeof p.const === 'number' ||
            typeof p.const === 'boolean')
        ? [p.const]
        : null;
    const type =
      enumValues && enumValues.length > 0
        ? `enum(${enumValues.join('|')})`
        : typeof p.type === 'string'
          ? p.type
          : '';
    // EI-13181: same lossy-discovery bug class as EI-13164/EI-13176, but for a
    // number/string/array BOUND instead of an enum — `z.number().max(100)` etc.
    // renders its JSON-schema `maximum`/`minimum`/`*Length`/`*Items` right next
    // to `type`, but schemaToText only ever read `type`, so a caller learned
    // `limit?:integer` with no hint that >100 is rejected until the call
    // failed. Render the bound inline (e.g. `integer(1-100)`, `string(≤400)`,
    // `array(≤20)`) whenever the schema declares one — strictly additive, never
    // fires for a property with no bound.
    const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const lo = numOrNull(p.minimum) ?? numOrNull(p.exclusiveMinimum) ?? numOrNull(p.minLength) ?? numOrNull(p.minItems);
    const hi = numOrNull(p.maximum) ?? numOrNull(p.exclusiveMaximum) ?? numOrNull(p.maxLength) ?? numOrNull(p.maxItems);
    const bound = lo != null && hi != null ? `${lo}-${hi}` : hi != null ? `≤${hi}` : lo != null ? `≥${lo}` : '';
    // EI-13183: same lossy-discovery bug class as EI-13181/13164, but for a
    // `.regex()` constraint — `z.string().regex(/^[0-9a-f]{40,64}$/)` (e.g.
    // locks:release's published_sha) emits JSON-schema `pattern` right next to
    // `type`, invisible to schemaToText until now. A caller passed a plausible
    // abbreviated git SHA and only learned the real 40–64 hex-char requirement
    // from the rejection. Render the pattern inline whenever present — strictly
    // additive; never fires for a property with no `.regex()`.
    const pattern = typeof p.pattern === 'string' && p.pattern.length > 0 ? p.pattern : '';
    const nested = nestedObjectFieldsText(p);
    const desc = typeof p.description === 'string' ? p.description.trim() : '';
    // Never double up with the enum text (already shows its own values) — a
    // bound/pattern is meaningless for an enum anyway (zod never emits either
    // alongside one).
    const isEnum = !!(enumValues && enumValues.length > 0);
    const boundText = bound && !isEnum ? `(${bound})` : '';
    const patternText = pattern && !isEnum ? `~/${pattern}/` : '';
    // EI-20250807342723221: an array's item enum is part of the caller-facing
    // contract too. JSON Schema places it under `items`, so checking only the
    // property itself turns `states: z.array(z.enum(['open', 'failing']))`
    // into a misleading bare `array` and hides the only accepted values.
    const itemText = arrayItemConstraintText(p);
    const required = entry.presentIn === branches.length && entry.requiredInAll;
    const head = `${name}${required ? '' : '?'}${type ? `:${type}${boundText}${patternText}${nested}` : ''}`;
    const rendered = `${head}${itemText}`;
    parts.push(desc ? `${rendered} ${desc}` : rendered);
  }
  return parts.length > 0 ? `${unionHint ? `one-of:${unionHint}; ` : ''}${parts.join('; ')}` : null;
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
