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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
import {
  buildBuiltinToolCatalog,
  buildDistributionUnits,
  type DistributionUnitInfo,
} from '../static-tool-catalog';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, '../../../../');

// ─── static built-in tool catalog + in-repo distribution units ─────────────
// Scan logic lives in ../static-tool-catalog.ts (shared with
// prompt-blueprint-verb-catalog.test.ts, P-007, so there's exactly one static
// catalog scanner in the tree, not two drifting copies).

const BUILTIN_TOOLS = buildBuiltinToolCatalog(REPO);
type UnitInfo = DistributionUnitInfo;
const UNITS: UnitInfo[] = buildDistributionUnits(REPO);

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
  // Spawned-blueprint deps (a hive's memberBlueprints — generic-hive needs research/review/
  // vote) resolve against the built-in tier (blueprint-role-bundling P-007). Computed inline
  // since BLUEPRINT_IDS is declared below; same bundled dir.
  availableBlueprints: new Set(
    readdirSync(dirname(dirname(builtinBlueprintPath('base')))).filter((bp) =>
      existsSync(join(dirname(dirname(builtinBlueprintPath('base'))), bp, 'blueprint.yaml')),
    ),
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
/**
 * IDENTITY LAYERS (identities-v1-2026-08-30, P-021 / D-008): a built-in that
 * claims a `slots:` block is a facet stacked onto a kernel by `su-stack.ts` /
 * `mode:set` — "abstract — a layer, never runnable alone" in its own words. It
 * carries no spine/workItem and declares no tool dependencies of its own, so
 * neither the standalone schema-load nor the dependencies-block ratchet applies
 * to it. Detected STRUCTURALLY (the raw `slots` key), never by id list, so a
 * new layer needs no edit here and a layer that grows a spine is re-admitted to
 * both checks automatically.
 */
const IDENTITY_LAYERS = new Set(
  BLUEPRINT_IDS.filter((id) => {
    const raw = parseYaml(readFileSync(join(BLUEPRINTS_ROOT, id, 'blueprint.yaml'), 'utf8')) as
      | Record<string, unknown>
      | null;
    return raw?.slots !== undefined && raw?.spine === undefined;
  }),
);
const NOT_STANDALONE = (id: string) => ABSTRACT_PARENTS.has(id) || IDENTITY_LAYERS.has(id);

// ─── assertions ──────────────────────────────────────────────────────────────

describe('blueprint dependencies vs the static tool catalog', () => {
  it('derivation includes the universal base prompt for a child blueprint', () => {
    const script = join(REPO, 'scripts/derive-blueprint-deps.mjs');
    const report = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })) as {
      blueprints: Record<string, { personaFiles: string[]; candidates: { tools: string[] } }>;
    };
    const implement = report.blueprints.implement;
    expect(implement.personaFiles).toContain(
      'libs/papercusp/packages/harness/blueprints/base/prompts/worker.md',
    );
    expect(implement.candidates.tools).toContain('session:request-compaction');
  });

  it('static catalog sanity — tool scan + unit scan found the real surface', () => {
    // ~300 defineTool files across the scanned dirs; >20 in-repo plugin manifests.
    expect(BUILTIN_TOOLS.size).toBeGreaterThan(100);
    expect(UNITS.length).toBeGreaterThan(10);
    expect(BLUEPRINT_IDS.length).toBeGreaterThanOrEqual(14);
  });

  it('CALIBRATION: the identity-layer detector resolved the known layers, and only layers', () => {
    // A detector that silently matches nothing would re-admit every layer to the
    // standalone checks (loud); one that matched everything would make them
    // vacuous (silent) — pin both edges against real built-ins.
    expect(IDENTITY_LAYERS).toContain('su.mode-auto');
    expect(IDENTITY_LAYERS).not.toContain('implement');
    expect(IDENTITY_LAYERS).not.toContain('single-agent');
    expect(IDENTITY_LAYERS.size).toBeLessThan(BLUEPRINT_IDS.length / 2);
  });

  it('every built-in (except the abstract parents and identity layers) declares or inherits a dependencies block', () => {
    // The end-state guard for official-blueprints-cupboard-publish P-002: every
    // concrete built-in has a resolvable deps surface — either declared in its own
    // `blueprint.yaml` (`audit` may be explicit-empty) OR inherited wholesale through
    // `extends` from a parent that declares one. The ABSTRACT parents (`base`,
    // `single-agent`) go without — extends-merge REPLACES arrays, so a parent block
    // would be wiped by every child anyway. `external-bench` is the inherit case: it
    // `extends: coding` and deliberately overrides NOTHING (impartial-benchmark-suite
    // -2026-06-15 D-004 — the benchmark arm is `coding` byte-for-byte), so it inherits
    // coding's full deps without re-declaring them. A NEW concrete built-in must still
    // ship its dependencies — declared, or inherited via an extends chain that has them.
    const undeclared = BLUEPRINT_IDS.filter((id) => {
      if (NOT_STANDALONE(id)) return false;
      const raw = parseYaml(readFileSync(join(BLUEPRINTS_ROOT, id, 'blueprint.yaml'), 'utf8')) as
        | Record<string, unknown>
        | null;
      if (raw?.dependencies !== undefined) return false; // declared directly
      if (raw?.extends === undefined) return true; // no own block and no parent → genuinely missing
      // No own block but it extends a parent — exempt iff the merge chain actually
      // provides a non-empty deps block (extending an abstract, dep-less parent leaves
      // it empty → still flagged). Mirrors the runtime extends-merge the loader runs.
      try {
        const merged = loadBuiltinBlueprint(id).blueprint.dependencies;
        const inherited =
          !!merged &&
          [merged.tools, merged.packs, merged.plugins].some((a) => Array.isArray(a) && a.length > 0);
        return !inherited;
      } catch {
        return true; // can't resolve the chain → surface it as missing
      }
    });
    expect(
      undeclared,
      `built-ins missing a dependencies block (declare one — explicit-empty is fine — or inherit via extends): ${undeclared.join(', ')}`,
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

      it('loads through the extends-merge loader (the abstract parents and identity layers may not load standalone)', () => {
        if (!NOT_STANDALONE(id)) {
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
