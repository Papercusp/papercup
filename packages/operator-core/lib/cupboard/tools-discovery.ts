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
import type { DerivedPackCatalog } from './pack-catalog';

export interface ToolDiscoveryEntry {
  /** The MCP tool name (e.g. `repomix.pack`, `coord:send`). */
  tool: string;
  status: 'available' | 'installable';
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

export interface ToolsDiscoveryPayload {
  tools: ToolDiscoveryEntry[];
  counts: { available: number; installable: number };
  /** False when the Cupboard fetch failed — the UI shows a degraded banner. */
  cupboardReachable: boolean;
}

export interface ToolsDiscoveryFilters {
  /** Case-insensitive substring match on tool name OR providing unit name. */
  q?: string;
  /** Narrow to one resolution status. */
  status?: 'available' | 'installable';
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

/** Every tool name the catalog knows, resolved + filtered + sorted. */
export function buildToolsDiscovery(
  cat: DerivedPackCatalog,
  filters: ToolsDiscoveryFilters = {},
): ToolsDiscoveryPayload {
  const names = new Set<string>(cat.builtinTools);
  for (const t of cat.view.installedToolIndex.keys()) names.add(t);
  for (const t of cat.view.cupboardToolIndex.keys()) names.add(t);

  const q = filters.q?.trim().toLowerCase();
  const tools: ToolDiscoveryEntry[] = [];
  let available = 0;
  let installable = 0;

  for (const tool of [...names].sort()) {
    const res = resolveToolProvider(tool, cat.view);
    if (res.status === 'unknown') continue; // unreachable: names come from the view
    const entry: ToolDiscoveryEntry = {
      tool,
      status: res.status,
      provider: { ...res.provider },
    };
    if (res.provider.kind !== 'builtin') {
      const pack = cat.view.byName.get(res.provider.name);
      if (pack) entry.unit = unitOf(pack);
    }
    if (filters.status && entry.status !== filters.status) continue;
    if (q && !entry.tool.toLowerCase().includes(q) && !(entry.unit?.name.toLowerCase().includes(q) ?? false)) {
      continue;
    }
    if (entry.status === 'available') available += 1;
    else installable += 1;
    tools.push(entry);
  }

  return { tools, counts: { available, installable }, cupboardReachable: cat.cupboardReachable };
}
