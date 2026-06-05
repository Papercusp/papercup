/**
 * harness:create — scaffold a new harness and instantiate a Blueprint into it.
 * Composes the existing creation primitives (registry + per-harness PG schema +
 * local-dir init) and writes the git-canonical `.papercusp/blueprint.yaml`; the
 * runtime projects it to PG lazily (getEffectiveBlueprint) on first use, so the
 * file stays the source of truth (D-006/D-021). No `orchestrator.spawn` (P-007).
 *
 * requiresRepo (P-008): the blueprint's `knobs.requiresRepo` decides whether a
 * NEW harness gets a git repo (coding=true → git-init) or a repo-less state dir
 * (research=false → plain mkdir, NO git-init; runs PG/file-canonical with no git
 * operations). An existing `path` is used as-is either way.
 *
 * harness-blueprint-orchestration-2026-06-03 P-007 + P-008 / B1+B2.
 */
import { z } from 'zod';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { defineTool, getCatalog } from '@papercusp/agent-mcp';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { validateBlueprintDependencies } from '@papercusp/blueprint-distribution';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAndValidate } from '../blueprint/_resolve';

const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

export default defineTool({
  name: 'harness:create',
  description:
    'Create a harness and instantiate a Blueprint into it. Provide an existing repo `path` OR `parentDir`+`folderName` to make a new dir; choose the blueprint via `blueprintId` (a built-in to extend, e.g. "coding"/"research") OR an inline `blueprint` object. The blueprint\'s knobs.requiresRepo decides git-init: coding → a git repo, research → a repo-less state dir. Registers the harness, provisions its PG schema, writes the git-canonical .papercusp/blueprint.yaml. Returns {ok, slug, path, blueprint}.',
  guidance: {
    when: 'Spinning up a new managed harness (coding from a repo, or a repo-less research harness) configured by a blueprint. The agent-authorable path to a new harness.',
    notWhen: 'Running an existing harness (orchestrator). Authoring a blueprint without creating a harness — blueprint:create/extend.',
    chaining: 'blueprint:extend/validate → harness:create { slug, path|parentDir+folderName, blueprintId|blueprint }.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
        .describe('Unique harness slug'),
      path: z.string().min(1).optional().describe('Absolute path to an existing repo/dir'),
      parentDir: z.string().min(1).optional().describe('Parent dir to create a new harness folder in'),
      folderName: z.string().min(1).optional().describe('New folder name (with parentDir)'),
      blueprintId: z.string().min(1).optional().describe('A built-in blueprint to extend (coding/base/research)'),
      blueprint: z.record(z.string(), z.unknown()).optional().describe('An inline blueprint object (alternative to blueprintId)'),
    })
    .refine((a) => a.path != null || (a.parentDir != null && a.folderName != null), {
      message: 'pass `path`, or both `parentDir` and `folderName`',
    })
    .refine((a) => a.blueprintId != null || a.blueprint != null, {
      message: 'pass `blueprintId` or `blueprint`',
    }),
  async handler(args) {
    const { loadHarnessRegistry, saveHarnessRegistry } = await import('../../harness-registry');

    const reg = await loadHarnessRegistry();
    if (reg.projects.some((p) => p.slug === args.slug)) return fail({ error: 'slug already exists' });

    // 1. Resolve + validate the blueprint FIRST — knobs.requiresRepo drives the
    //    dir/git decision below. `blueprintId` → a thin inheriting child
    //    (`{ id: slug, extends: <id> }`); `blueprint` → as-authored.
    const childObj: Record<string, unknown> = args.blueprint ?? { id: args.slug, extends: args.blueprintId };
    const validation = resolveAndValidate(childObj);
    if (validation.parseError || !validation.ok) {
      return fail({ error: 'blueprint invalid', parseError: validation.parseError, errors: validation.validation?.errors });
    }
    if (args.blueprintId) {
      try {
        loadBuiltinBlueprint(args.blueprintId);
      } catch (e) {
        return fail({ error: `unknown built-in blueprint "${args.blueprintId}": ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    const requiresRepo = validation.blueprint!.knobs.requiresRepo !== false;

    // 1b. Import-time dependency validation (harness-blueprint-distribution
    //     E2 — P-003/P-004; revive-cupboard-distribution D-003 — the plugin half).
    //     A blueprint that declares a TOOL its roles need which is NOT in the
    //     in-process catalog fails HERE, at create — closing the call-time
    //     `unknown_tool` gap (capabilities/invoke.ts). A declared PLUGIN must be
    //     installed OR available in the Cupboard (now that E4's 3-kind storefront
    //     landed) — a plugin in NEITHER fails with a truthful "needs plugin X".
    //     Fail-fast: before any dir/registry/schema side effect. No-op for a
    //     blueprint that declares no tool/plugin deps (the guard short-circuits).
    const declaredTools = validation.blueprint!.dependencies?.tools ?? [];
    const declaredPlugins = validation.blueprint!.dependencies?.plugins ?? [];
    if (declaredTools.length > 0 || declaredPlugins.length > 0) {
      const { resolveCupboardPluginNames, listInstalledPluginNames } = await import('../../cupboard/plugin-listings');
      const availableTools = new Set(getCatalog().map((t) => t.name));
      const [installedPlugins, cupboard] = await Promise.all([
        declaredPlugins.length > 0 ? listInstalledPluginNames() : Promise.resolve(new Set<string>()),
        declaredPlugins.length > 0 ? resolveCupboardPluginNames() : Promise.resolve({ names: new Set<string>(), reachable: true }),
      ]);
      const depCheck = validateBlueprintDependencies(
        { tools: declaredTools, plugins: declaredPlugins },
        { availableTools, installedPlugins, cupboardPlugins: cupboard.names },
      );
      // Tools are a hard gate (catalog is in-process, always authoritative).
      if (depCheck.missing.tools.length > 0) {
        return fail({ error: 'blueprint tool dependencies unmet', missing: { tools: depCheck.missing.tools }, messages: depCheck.messages });
      }
      // Plugins: hard-fail only when the Cupboard was actually reachable — a
      // transient cupboard-unreachable must not false-fail a plugin that may be
      // installable there. `installable` plugins (in the Cupboard) never block.
      if (cupboard.reachable && depCheck.missing.plugins.length > 0) {
        return fail({
          error: 'blueprint plugin dependencies unmet',
          missing: { plugins: depCheck.missing.plugins },
          installable: depCheck.installable,
          messages: depCheck.messages,
        });
      }
    }

    // 2. Resolve / create the harness directory — conditional on requiresRepo (P-008).
    let path: string;
    let gitInitialized = false;
    if (args.path != null) {
      path = resolvePath(args.path);
      if (!existsSync(path)) return fail({ error: 'path does not exist' });
    } else {
      const dest = resolvePath(join(args.parentDir!, args.folderName!));
      if (existsSync(dest)) return fail({ error: 'destination already exists' });
      if (requiresRepo) {
        // coding-style: git-init a real repo via the shared helper.
        const { initLocalHarnessDir } = await import('../../harness/init-local-dir');
        const init = await initLocalHarnessDir({ parentDir: args.parentDir!, folderName: args.folderName! });
        path = init.path;
        gitInitialized = true;
      } else {
        // research / repo-less: a plain state dir, NO git-init. The harness runs
        // PG/file-canonical with no git operations (P-008).
        mkdirSync(dest, { recursive: true });
        path = dest;
      }
    }

    // 3. Register the harness + provision its PG schema.
    reg.projects.push({ slug: args.slug, path });
    await saveHarnessRegistry(reg);
    let provisioning: { ok: true } | { ok: false; error: string };
    try {
      const { scaffoldHarnessSchema } = await import('../../scaffold-harness-schema');
      await scaffoldHarnessSchema(args.slug);
      provisioning = { ok: true };
    } catch (e) {
      provisioning = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }

    // 4. Write the git-canonical blueprint file. PG projection is lazy.
    const bpDir = join(path, '.papercusp');
    mkdirSync(bpDir, { recursive: true });
    const bpFile = join(bpDir, 'blueprint.yaml');
    writeFileSync(bpFile, stringifyYaml(childObj, { lineWidth: 100 }), 'utf8');

    // 5. Materialize the blueprint's triggers.schedule into harness_shared.routines
    //    (P-021/D-018). Each entry → a cron routine whose target_role is its action
    //    (default system:blueprint-run); the shipped routinesTick dispatches due rows.
    //    Best-effort — a routines hiccup must not fail harness creation.
    let scheduledRoutines: string[] = [];
    try {
      const { materializeBlueprintTriggers } = await import('../../blueprint/materialize-triggers');
      const rows = await materializeBlueprintTriggers(args.slug, validation.blueprint!);
      scheduledRoutines = rows.map((r) => r.name);
    } catch (e) {
      console.warn(`[harness:create] materialize triggers failed (${args.slug}): ${e instanceof Error ? e.message : e}`);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: args.slug,
            path,
            requiresRepo,
            gitInitialized,
            blueprintFile: bpFile,
            blueprint: { id: validation.blueprint!.id, version: validation.blueprint!.version },
            warnings: validation.validation!.warnings,
            provisioning,
            scheduledRoutines,
          }),
        },
      ],
    };
  },
});
