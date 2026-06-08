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
import { defineTool } from '@papercusp/agent-mcp';
import { validateBlueprintDependencies } from '@papercusp/blueprint-distribution';
import { COORD_ROLES } from '../coordination/roles';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../blueprint/_resolve';
import { DeploymentConfigSchema, parseDeploymentConfig } from '../../deployment/config-schema';
import { resolveCreateHiveMembership } from './create-hive-membership';

const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

export default defineTool({
  name: 'harness:create',
  description:
    'Create a harness and instantiate a Blueprint into it. Provide an existing repo `path` OR `parentDir`+`folderName` to make a new dir; choose the blueprint via `blueprintId` (resolved local → installed → built-in, e.g. "coding"/"research" or a Cupboard-installed id) OR an inline `blueprint` object. The blueprint\'s knobs.requiresRepo decides git-init: coding → a git repo, research → a repo-less state dir. Registers the harness, provisions its PG schema, writes the git-canonical .papercusp/blueprint.yaml. Returns {ok, slug, path, blueprint}.',
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
      blueprintId: z.string().min(1).optional().describe('A blueprint to extend — resolved local → installed → built-in (e.g. coding/base/research or a Cupboard-installed id)'),
      blueprint: z.record(z.string(), z.unknown()).optional().describe('An inline blueprint object (alternative to blueprintId)'),
      deployment: DeploymentConfigSchema.optional().describe('Where this harness\'s execution plane runs — a sibling to the blueprint (cloud-deployment-layer D-001). Omit ⇒ {target:"local"}. e.g. {target:"latitude",region:"NYC",kind:"vm"}.'),
      hive: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'hive must be a harness slug')
        .optional()
        .describe('Create this harness directly INTO a Hive: the home slug of a kind:\'hive\' harness. Stamps the new harness\'s hive_slug so its substrate federates over the Hive topic (shared-hive-federation D-010 create-time membership producer). Omit ⇒ a standalone harness. The complement of hive:add-member (which adds an EXISTING harness).'),
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

    // Create-time Hive membership (shared-hive-federation D-010 producer): when
    // `hive` is given, validate it's a real Hive home + capture the hive_slug to
    // stamp on the new registry entry below. Fail-fast before any dir/schema side
    // effect, like the deployment + dependency gates. No nesting guard needed —
    // harness:create never sets harness_kind, so the new harness is never a Hive
    // home (Hive homes come only from hive:create), so it cannot nest a Hive.
    let hiveMembership: string | undefined;
    if (args.hive != null) {
      const membership = resolveCreateHiveMembership(reg, args.hive);
      if (!membership.ok) return fail({ error: membership.error, message: membership.message });
      hiveMembership = membership.hive_slug;
    }

    // 1. Resolve + validate the blueprint FIRST — knobs.requiresRepo drives the
    //    dir/git decision below. `blueprintId` → a thin inheriting child
    //    (`{ id: slug, extends: <id> }`); `blueprint` → as-authored.
    //    `extends` resolution is composed (D-005): the target repo's local
    //    `.papercusp/blueprints` (when `path` is given) → installed
    //    (`~/.papercusp/blueprints`, Cupboard-installed) → built-in.
    const resolver = operatorResolveExtends({
      localDirs: args.path != null ? [join(resolvePath(args.path), '.papercusp', 'blueprints')] : [],
    });
    const childObj: Record<string, unknown> = args.blueprint ?? { id: args.slug, extends: args.blueprintId };
    const validation = resolveAndValidate(childObj, resolver);
    if (validation.parseError || !validation.ok) {
      return fail({ error: 'blueprint invalid', parseError: validation.parseError, errors: validation.validation?.errors });
    }
    if (args.blueprintId && resolver(args.blueprintId) == null) {
      return fail({ error: `unknown blueprint "${args.blueprintId}" — not in the local, installed, or built-in tiers` });
    }
    const requiresRepo = validation.blueprint!.knobs.requiresRepo !== false;

    // 1a. Validate the deployment config (cloud-deployment-layer P-003). Deployment
    //     is a SIBLING input to the blueprint (D-001), not a blueprint property —
    //     it describes where THIS install's execution plane runs. Defaults to
    //     {target:'local'} so existing harnesses are unaffected. Fail-fast on a
    //     non-local target with no registered driver (a cloud backend registers
    //     its driver via configureDeployment at operator bootstrap).
    const deploymentResult = parseDeploymentConfig(args.deployment);
    if (!deploymentResult.ok) {
      return fail({ error: deploymentResult.error, registeredTargets: deploymentResult.registeredTargets });
    }
    const deployment = deploymentResult.config;

    // 1b. Import-time dependency validation (harness-blueprint-distribution
    //     E2 — P-003/P-004; revive-cupboard-distribution D-003;
    //     tool-distribution-granularity D-002/D-006 — the pack model).
    //     A blueprint declares `dependencies.{tools,packs,plugins}`; the gate
    //     resolves each against the live pack catalog (built-ins + installed
    //     units + Cupboard listings) HERE, at create — closing the call-time
    //     `unknown_tool` gap (capabilities/invoke.ts). A declared tool with no
    //     known provider hard-fails; a tool/pack/plugin installable from the
    //     Cupboard is advisory. Fail-fast: before any dir/registry/schema side
    //     effect. No-op for a blueprint that declares no deps.
    const declaredTools = validation.blueprint!.dependencies?.tools ?? [];
    const declaredPacks = validation.blueprint!.dependencies?.packs ?? [];
    const declaredPlugins = validation.blueprint!.dependencies?.plugins ?? [];
    if (declaredTools.length > 0 || declaredPacks.length > 0 || declaredPlugins.length > 0) {
      const { derivePackCatalog, depHostSetsFromCatalog } = await import('../../cupboard/pack-catalog');
      // Local-only first: when every declared dep resolves in-process, skip
      // the Cupboard round-trip entirely.
      const localCatalog = await derivePackCatalog({ includeCupboard: false });
      const localCheck = validateBlueprintDependencies(
        { tools: declaredTools, packs: declaredPacks, plugins: declaredPlugins },
        depHostSetsFromCatalog(localCatalog),
      );
      let depCheck = localCheck;
      let cupboardReachable = true;
      if (!localCheck.ok) {
        const catalog = await derivePackCatalog({});
        cupboardReachable = catalog.cupboardReachable;
        depCheck = validateBlueprintDependencies(
          { tools: declaredTools, packs: declaredPacks, plugins: declaredPlugins },
          depHostSetsFromCatalog(catalog),
        );
      }
      // Tools with NO known provider are a hard gate (the in-process catalog is
      // authoritative; a Cupboard-installable provider downgrades to advisory).
      if (depCheck.missing.tools.length > 0) {
        return fail({
          error: 'blueprint tool dependencies unmet',
          missing: { tools: depCheck.missing.tools },
          installable: depCheck.installable,
          messages: depCheck.messages,
        });
      }
      // Packs/plugins: hard-fail only when the Cupboard was actually reachable —
      // a transient cupboard-unreachable must not false-fail a unit that may be
      // installable there. `installable` units (in the Cupboard) never block.
      if (cupboardReachable && (depCheck.missing.plugins.length > 0 || depCheck.missing.packs.length > 0)) {
        return fail({
          error: 'blueprint pack/plugin dependencies unmet',
          missing: { packs: depCheck.missing.packs, plugins: depCheck.missing.plugins },
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

    // 3. Register the harness + provision its PG schema. The deployment config is
    //    persisted on the registry entry (workspace PG) — local omits it.
    reg.projects.push({
      slug: args.slug,
      path,
      ...(hiveMembership ? { hive_slug: hiveMembership } : {}),
      ...(deployment.target !== 'local' ? { deployment } : {}),
    });
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
            deployment,
            ...(hiveMembership ? { hive: hiveMembership } : {}),
            warnings: validation.validation!.warnings,
            provisioning,
            scheduledRoutines,
          }),
        },
      ],
    };
  },
});
