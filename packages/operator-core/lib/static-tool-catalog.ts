/**
 * Shared static tool/unit catalog builder — pure filesystem scan, no operator
 * process, no network, no PG.
 *
 * Originally inlined in `__tests__/blueprint-deps-catalog.test.ts` (which
 * itself mirrors `__tests__/tools-md-sync.test.ts`'s catalog builder).
 * Extracted here (agent-trap-guards-2026-07-26 P-007) so a SECOND static
 * catalog scanner didn't need constructing for
 * `__tests__/prompt-blueprint-verb-catalog.test.ts` — both tests now import
 * the same scan instead of each maintaining their own copy that can drift.
 *
 * - built-in tools = defineTool `name:` scans of packages/agent-mcp/src/tools,
 *   packages/operator-core/lib/agent-tools, packages/operator-core/lib/coord-ops,
 *   and packages/operator-core/lib/endpoint-route/routes (the same source dirs
 *   the live catalog registers from);
 * - distribution units = libs/papercusp/plugins/<x>/papercusp.json manifests
 *   (manifest kind=pack → pack, else plugin), tool names from `tools[]`
 *   (`expose.mcp.name` ?? `<short>.<tool.name>`) + dynamic `tools:<g>:<v>`
 *   capabilities.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Every dir that holds `defineTool({ name: '<group>:<verb>' })` projections.
// Wider than the classic two dirs: coord-ops/agent-tools.ts (the dual-surface
// coord:vote/deliberate/ask-owner projections) and agent-mcp's define-ui-tool
// live outside them. If a dep/reference fails for a tool that exists live,
// the fix is extending this list.
export const TOOL_SOURCE_DIRS = [
  'packages/agent-mcp/src',
  'packages/operator-core/lib/agent-tools',
  'packages/operator-core/lib/coord-ops',
  'packages/operator-core/lib/endpoint-route/routes',
];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/** Every `defineTool({ name: '...' })` string found under TOOL_SOURCE_DIRS, repo-root-relative. */
export function buildBuiltinToolCatalog(repoRoot: string): Set<string> {
  const tools = new Set<string>();
  for (const dir of TOOL_SOURCE_DIRS) {
    for (const file of walkTsFiles(join(repoRoot, dir))) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('defineTool(')) continue;
      // matchAll — a file may define more than one tool.
      for (const m of src.matchAll(/name:\s*['"]([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-]+)['"]/g)) {
        tools.add(m[1]);
      }
    }
  }
  return tools;
}

/**
 * Tool name → the source file(s) whose `defineTool({ name: … })` declares it,
 * absolute paths. Same single scan as {@link buildBuiltinToolCatalog} (that one
 * throws the paths away); this keeps them so a caller holding only a NAME — e.g.
 * one derived from prompt text — can import the owning module and read the REAL
 * descriptor (`agentRoles`, `capability`) instead of re-parsing the source.
 *
 * A name maps to a list, not a single path: `register()` deliberately tolerates a
 * benign re-import of the same tool, so a duplicate is a fact about the tree the
 * caller should see rather than a silently-dropped entry.
 */
export function buildBuiltinToolFileIndex(repoRoot: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const dir of TOOL_SOURCE_DIRS) {
    for (const file of walkTsFiles(join(repoRoot, dir))) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('defineTool(')) continue;
      for (const m of src.matchAll(/name:\s*['"]([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-]+)['"]/g)) {
        const existing = index.get(m[1]);
        if (existing) existing.push(file);
        else index.set(m[1], [file]);
      }
    }
  }
  return index;
}

export interface DistributionUnitInfo {
  name: string;
  kind: 'plugin' | 'pack';
  tools: string[];
}

/** Every libs/papercusp/plugins/<x>/papercusp.json manifest's declared tool names. */
export function buildDistributionUnits(repoRoot: string): DistributionUnitInfo[] {
  const units: DistributionUnitInfo[] = [];
  const pluginsRoot = join(repoRoot, 'libs/papercusp/plugins');
  if (!existsSync(pluginsRoot)) return units;
  for (const entry of readdirSync(pluginsRoot)) {
    const manifestPath = join(pluginsRoot, entry, 'papercusp.json');
    if (!existsSync(manifestPath)) continue;
    const json = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const short = String(json.name ?? entry).replace(/^@[^/]+\//, '');
    const tools: string[] = [];
    if (Array.isArray(json.tools)) {
      for (const tool of json.tools as Array<Record<string, any>>) {
        tools.push(tool.expose?.mcp?.name ?? `${short}.${tool.name}`);
      }
    }
    if (Array.isArray(json.capabilities)) {
      for (const cap of json.capabilities as string[]) {
        const m = /^tools:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(cap);
        if (m) tools.push(`${m[1]}.${m[2]}`);
      }
    }
    units.push({ name: short, kind: json.kind === 'pack' ? 'pack' : 'plugin', tools });
  }
  return units;
}

/** Convenience: the flat union of every builtin tool name + every distribution unit's projected tool name. */
export function buildFullToolNameCatalog(repoRoot: string): Set<string> {
  const all = buildBuiltinToolCatalog(repoRoot);
  for (const unit of buildDistributionUnits(repoRoot)) {
    for (const t of unit.tools) all.add(t);
  }
  return all;
}
