/**
 * blueprint:catalog — list every blueprint the operator can instantiate, with
 * enough of each one's shape (roles, spine model, triggers, dispatch) for the
 * Pot operator to CHOOSE which harness to spin up. The discovery half of the
 * operator's superpower (blueprint:catalog → harness:create).
 *
 * Tiers mirror the composed `extends` resolver (installed shadows built-in;
 * the local tier needs a project context the operator-scope catalog doesn't
 * have). A blueprint that fails to load/validate stays in the listing as an
 * `{ id, tier, error }` entry — a broken installed blueprint must not hide the
 * rest of the catalog.
 *
 * autoloop-pot-operator-rebuild-2026-06-05 P-003 (P1).
 */
import { z } from 'zod';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { builtinBlueprintPath, isProgramSpine, loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { COORD_ROLES } from '../coordination/roles';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { BUILTIN_LAUNCH_BLUEPRINTS } from '../../blueprint/launch-blueprint';

/** Ids under a `<root>/<id>/blueprint.yaml` layout (the tier convention). */
function listIdsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'blueprint.yaml')))
    .map((e) => e.name)
    .sort();
}

export default defineTool({
  name: 'blueprint:catalog',
  description:
    'List the blueprints available to instantiate — built-in + Cupboard-installed (installed shadows built-in, like the extends resolver). Each entry summarizes the shape: id, tier, version, description, workItem kind, decider + roles, spine model (decider-edges vs program-steps), triggers, dispatch policy (when declared), requiresRepo, and whether it is a one-shot launch blueprint (fired via system:blueprint-run) vs a harness pipeline (instantiated via harness:create). Broken entries are kept as {id, tier, error}.',
  guidance: {
    when: "Deciding WHICH blueprint shape fits a piece of work before creating a harness — the Pot operator's first stop (decomposable features → coding, investigation → research, parallel codemod → migration, a decision → vote/deliberate). Also the discovery surface for what launch blueprints exist.",
    notWhen: 'Deep-inspecting one blueprint (validation errors/warnings) — blueprint:validate {id}. Authoring — blueprint:create/extend.',
    chaining: 'blueprint:catalog → blueprint:validate {id} → harness:create {blueprintId} (pipelines) or fire the launchable ones via their trigger/system:blueprint-run.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    tier: z
      .enum(['builtin', 'installed', 'all'])
      .default('all')
      .describe('Restrict to one distribution tier (default all). An installed id that shadows a built-in lists as installed.'),
  }),
  async handler(args) {
    // The built-in root is wherever the loader's resolver actually reads from —
    // derive it from builtinBlueprintPath so enumeration can never drift from
    // resolution (`<root>/<id>/blueprint.yaml` → two dirnames up).
    const builtinRoot = dirname(dirname(builtinBlueprintPath('probe')));
    const builtinIds = new Set(listIdsIn(builtinRoot));
    const installedIds = new Set(listIdsIn(INSTALLED_BLUEPRINTS_DIR()));
    const resolver = operatorResolveExtends();
    const launchable = new Set<string>(BUILTIN_LAUNCH_BLUEPRINTS);

    const ids = [...new Set([...builtinIds, ...installedIds])].sort().filter((id) => {
      const tier = installedIds.has(id) ? 'installed' : 'builtin';
      return args.tier === 'all' || tier === args.tier;
    });

    const blueprints = ids.map((id) => {
      const tier = installedIds.has(id) ? ('installed' as const) : ('builtin' as const);
      const base = {
        id,
        tier,
        ...(tier === 'installed' && builtinIds.has(id) ? { shadowsBuiltin: true } : {}),
        launchable: launchable.has(id),
      };
      try {
        const file = resolver(id);
        if (!file) throw new Error(`unresolvable blueprint "${id}"`);
        const { blueprint: bp, validation } = loadBlueprintFromFile(file, resolver);
        return {
          ...base,
          version: bp.version,
          description: bp.description,
          workItemKind: bp.workItem.kind,
          decider: bp.spine.decider,
          roles: bp.roles.map((r) => ({ id: r.id, ...(r.description ? { description: r.description } : {}) })),
          spineModel: isProgramSpine(bp.spine) ? ('program-steps' as const) : ('decider-edges' as const),
          spineVerbs: Object.keys(bp.spine.edges ?? {}),
          spineSteps: (bp.spine.steps ?? []).map((s) => s.id),
          triggers: bp.triggers,
          // Lights up once the `dispatch:` blueprint section (D-005, Brief 2) is
          // in BlueprintSchema — read loosely so the catalog needs no edit then.
          dispatch: (bp as { dispatch?: unknown }).dispatch,
          requiresRepo: bp.knobs.requiresRepo,
          ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
        };
      } catch (e) {
        // Keep the broken entry visible — a catalog that silently drops a
        // mid-edit/invalid blueprint reads as "doesn't exist".
        return { ...base, error: e instanceof Error ? e.message : String(e) };
      }
    });

    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: blueprints.length, blueprints }) }] };
  },
});
