/**
 * Static assertions: every built-in blueprint's declared `dependencies`
 * ({tools, packs, plugins}) resolves against the static tool catalog + the
 * in-repo plugin/pack manifests
 * (official-blueprints-cupboard-publish-2026-06-05 P-002/D-002, packs-aware
 * per tool-distribution-granularity-2026-06-05 D-001/D-002).
 *
 * Mirrors tools-md-sync.test.ts's static CATALOG builder so a typo'd tool
 * name or an unknown plugin/pack dep in a blueprint.yaml fails CI at commit
 * time instead of surfacing as an import-time failure at `harness:create` /
 * `init --from`.
 *
 * Pure-static — no operator process, no network, no PG:
 *   - built-in tools = defineTool `name:` scans of packages/agent-mcp/src/tools,
 *     packages/operator-core/lib/agent-tools, and
 *     packages/operator-core/lib/endpoint-route/routes (the same source dirs
 *     the live catalog registers from);
 *   - distribution units = libs/papercusp/plugins/<x>/papercusp.json manifests
 *     (manifest kind=pack → pack, else plugin), tool names from `tools[]`
 *     (`expose.mcp.name` ?? `<short>.<tool.name>`) + dynamic `tools:<g>:<v>`
 *     capabilities — counted as the CUPBOARD (installable) tier, NOT
 *     installed: a fresh host has none of them, so a blueprint's deps must
 *     resolve via `installable`, never assume presence;
 *   - blueprints = the bundled built-ins, loaded through the real
 *     extends-merge loader so the validated deps are exactly what the
 *     runtime import-time validation sees post-merge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  loadBuiltinBlueprint,
  builtinBlueprintPath,
} from '@papercusp/orchestrator/blueprint';
import {
  validateBlueprintDependencies,
  parseDepSpec,
  buildPackCatalogView,
  type DependencyHostSets,
  type PackDescriptor,
} from '@papercusp/blueprint-distribution';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, '../../../../');

// ─── static built-in tool catalog (mirror of tools-md-sync's Pass 1) ────────

// Every dir that holds `defineTool({ name: '<group>:<verb>' })` projections.
// Wider than tools-md-sync's scan: coord-ops/agent-tools.ts (the dual-surface
// coord:vote/deliberate/ask-owner projections) and agent-mcp's define-ui-tool
// live OUTSIDE the two classic dirs. If a dep fails here for a tool that
// exists live, the fix is extending this list (the failure message names the
// tool).
const TOOL_SOURCE_DIRS = [
  'packages/agent-mcp/src',
  'packages/operator-core/lib/agent-tools',
  'packages/operator-core/lib/coord-ops',
  // A couple of endpoint routes carry an MCP `name:` projection too.
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

const BUILTIN_TOOLS = new Set<string>();
for (const dir of TOOL_SOURCE_DIRS) {
  for (const file of walkTsFiles(join(REPO, dir))) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('defineTool(')) continue;
    // Same shape as tools-md-sync: a name with a `:`/`.` separator. matchAll —
    // a file may define more than one tool.
    for (const m of src.matchAll(/name:\s*['"]([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-]+)['"]/g)) {
      BUILTIN_TOOLS.add(m[1]);
    }
  }
}

// ─── in-repo distribution units (plugins + packs), the installable tier ─────

interface UnitInfo {
  name: string;
  kind: 'plugin' | 'pack';
  tools: string[];
}

const UNITS: UnitInfo[] = [];
const pluginsRoot = join(REPO, 'libs/papercusp/plugins');
if (existsSync(pluginsRoot)) {
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
    UNITS.push({ name: short, kind: json.kind === 'pack' ? 'pack' : 'plugin', tools });
  }
}

const DESCRIPTORS: PackDescriptor[] = UNITS.map((u) => ({
  name: u.name,
  tools: u.tools,
  hasRuntime: u.kind === 'plugin',
  kind: u.kind,
  source: 'cupboard', // installable, not installed — the fresh-host posture
}));

const VIEW = buildPackCatalogView(DESCRIPTORS, BUILTIN_TOOLS);

const HOST: DependencyHostSets = {
  availableTools: BUILTIN_TOOLS,
  installedPlugins: new Set(),
  cupboardPlugins: new Set(UNITS.filter((u) => u.kind === 'plugin').map((u) => u.name)),
  installedPacks: new Set(),
  cupboardPacks: new Set(UNITS.filter((u) => u.kind === 'pack').map((u) => u.name)),
  installableToolProviders: new Map(
    [...VIEW.cupboardToolIndex].map(([tool, unit]) => [tool, { kind: unit.kind, name: unit.name }]),
  ),
};

// ─── the bundled built-in blueprints ─────────────────────────────────────────

// Derive the bundled dir from the loader's own path resolution — no hardcoding.
const BLUEPRINTS_ROOT = dirname(dirname(builtinBlueprintPath('base')));
const BLUEPRINT_IDS = readdirSync(BLUEPRINTS_ROOT).filter((id) =>
  existsSync(join(BLUEPRINTS_ROOT, id, 'blueprint.yaml')),
);

// The ABSTRACT parent blueprints — they declare no `workItem` / `spine.decider` of
// their own and are NEVER loaded standalone (only via an `extends` merge), so they
// are exempt from the "declares deps" + "loads standalone" assertions. `base` is the
// root; `single-agent` is the single-role run-to-done parent (unify-agent-spawn-
// chokepoint P-014). Children of either ship their own deps — extends-merge REPLACES
// arrays, so a parent block would be wiped by every child anyway.
const ABSTRACT_PARENTS = new Set(['base', 'single-agent']);

// ─── assertions ──────────────────────────────────────────────────────────────

describe('blueprint dependencies vs the static tool catalog', () => {
  it('static catalog sanity — tool scan + unit scan found the real surface', () => {
    // ~300 defineTool files across the scanned dirs; >20 in-repo plugin manifests.
    expect(BUILTIN_TOOLS.size).toBeGreaterThan(100);
    expect(UNITS.length).toBeGreaterThan(10);
    expect(BLUEPRINT_IDS.length).toBeGreaterThanOrEqual(14);
  });

  it('every built-in (except the abstract parents) declares a dependencies block', () => {
    // The end-state guard for official-blueprints-cupboard-publish P-002: the
    // concrete built-ins declare deps (`audit` may be explicit-empty); only the
    // ABSTRACT parents (`base`, `single-agent` — extends-merge REPLACES arrays, so a
    // parent block would be wiped by every child anyway) go without one. A NEW
    // concrete built-in must ship with its dependencies declared.
    const undeclared = BLUEPRINT_IDS.filter((id) => {
      if (ABSTRACT_PARENTS.has(id)) return false;
      const raw = parseYaml(readFileSync(join(BLUEPRINTS_ROOT, id, 'blueprint.yaml'), 'utf8')) as
        | Record<string, unknown>
        | null;
      return raw?.dependencies === undefined;
    });
    expect(
      undeclared,
      `built-ins missing a dependencies block (declare one — explicit-empty is fine): ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('dep-validator fails loud on an unknown tool and a missing plugin dep', () => {
    const v = validateBlueprintDependencies(
      { tools: ['no:such-tool'], plugins: ['ghost-plugin'] },
      HOST,
    );
    expect(v.ok).toBe(false);
    expect(v.missing.tools).toEqual(['no:such-tool']);
    expect(v.missing.plugins).toEqual(['ghost-plugin']);
    expect(v.messages.join('\n')).toMatch(/needs tool "no:such-tool"/);
    expect(v.messages.join('\n')).toMatch(/needs plugin "ghost-plugin"/);
  });

  for (const id of BLUEPRINT_IDS) {
    describe(`built-in "${id}"`, () => {
      // The ABSTRACT parents (`base`, `single-agent`) have no `workItem` of their
      // own — they can't pass a full schema-load standalone; fall back to the raw
      // declared block. Any OTHER built-in failing to load is a broken blueprint.
      let deps: { tools?: string[]; packs?: string[]; plugins?: string[] } | undefined;
      let loadError: unknown;
      try {
        deps = loadBuiltinBlueprint(id).blueprint.dependencies;
      } catch (e) {
        loadError = e;
        const raw = parseYaml(readFileSync(join(BLUEPRINTS_ROOT, id, 'blueprint.yaml'), 'utf8')) as
          | Record<string, unknown>
          | null;
        deps = (raw?.dependencies ?? undefined) as typeof deps;
      }

      it('loads through the extends-merge loader (the abstract parents may not load standalone)', () => {
        if (!ABSTRACT_PARENTS.has(id)) {
          expect(loadError, `built-in "${id}" failed to load: ${String(loadError)}`).toBeUndefined();
        }
      });

      it('declared dependencies contain no wildcards (validator is exact-name)', () => {
        const all = [...(deps?.tools ?? []), ...(deps?.packs ?? []), ...(deps?.plugins ?? [])];
        const wild = all.filter((d) => d.includes('*'));
        expect(
          wild,
          `validateBlueprintDependencies has no wildcard semantics — declare concrete names instead of: ${wild.join(', ')}`,
        ).toEqual([]);
      });

      it('resolved (post-extends-merge) dependencies validate against the static catalog', () => {
        const v = validateBlueprintDependencies(deps, HOST);
        expect(
          v.ok,
          `"${id}" declares unresolvable deps:\n${v.messages.join('\n')}\n` +
            `(checked against ${BUILTIN_TOOLS.size} static built-in tools + units: ${UNITS.map((u) => u.name).join(', ')})`,
        ).toBe(true);
      });

      it('every declared plugin/pack name is a known unit', () => {
        // validateBlueprintDependencies already enforces this; this assertion
        // exists to attribute the failure to the exact dep string.
        for (const spec of deps?.plugins ?? []) {
          const { name } = parseDepSpec(spec);
          expect(
            HOST.cupboardPlugins!.has(name) || HOST.installedPlugins.has(name),
            `"${id}" declares plugin "${spec}" — no such in-repo plugin manifest (libs/papercusp/plugins/*)`,
          ).toBe(true);
        }
        for (const spec of deps?.packs ?? []) {
          const { name } = parseDepSpec(spec);
          const known =
            HOST.cupboardPacks!.has(name) ||
            HOST.installedPacks!.has(name) ||
            HOST.cupboardPlugins!.has(name) || // a plugin IS a runtime-bearing pack (D-001)
            HOST.installedPlugins.has(name);
          expect(known, `"${id}" declares pack "${spec}" — no such in-repo unit`).toBe(true);
        }
      });
    });
  }
});
