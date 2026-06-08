/**
 * createHiveHarness — provision a new local hive's home harness
 * (hive-tool-namespace-2026-06-08 P-004, D-005).
 *
 * Composes the SAME primitives `harness:create` uses (blueprint resolve+validate,
 * dir provision, registry, schema scaffold, blueprint.yaml, trigger
 * materialization) for the built-in `pot` (kind:'hive') blueprint — but with two
 * hive-specific differences:
 *   1. it stamps `harness_kind: 'hive'` on the registry entry (harness:create
 *      never sets harness_kind, so resolveHive could not otherwise find it), and
 *   2. it optionally fires the initial Queen wake (a ROOT, parentless launch).
 *
 * Transactional: each side effect pushes an undo onto a stack; a failure rolls
 * them back in reverse so a half-made hive (registered, no schema, dangling dir)
 * never lingers (D-005). The pot is a built-in blueprint with no external deps,
 * so the cupboard dependency-validation gate in harness:create is intentionally
 * omitted here.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { getOrgPg } from '@papercusp/db-org';
import type { DeploymentConfig } from '@papercusp/deployment-driver';
import { loadHarnessRegistry, saveHarnessRegistry } from '../../harness-registry';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../blueprint/_resolve';
import { fireLaunchBlueprint } from '../../blueprint/launch-blueprint';
import { POT_BLUEPRINT_ID, declarePotTimeWake, recordPotWake } from '../../pot/wake';
import { HIVE_KIND } from './_resolve';

export interface CreateHiveOpts {
  slug: string;
  workspaceId: string;
  /** Parent dir for the home-harness folder. Default ~/.papercusp/hives. */
  parentDir?: string;
  deployment?: DeploymentConfig;
  /** Wake the Queen `wakeInSeconds` from now (0 = immediately). Omit ⇒ create
   *  idle (no wake declared; wake later via pot:wake / pot:declare-wake). */
  wakeInSeconds?: number;
  kickoff?: string;
}

export interface CreateHiveResult {
  ok: boolean;
  slug?: string;
  path?: string;
  waked?: boolean;
  error?: string;
  message?: string;
}

export async function createHiveHarness(opts: CreateHiveOpts): Promise<CreateHiveResult> {
  const ws = opts.workspaceId;

  const reg = await loadHarnessRegistry(ws);
  if (reg.projects.some((p) => p.slug === opts.slug)) {
    return { ok: false, error: 'slug_exists', message: `A harness '${opts.slug}' already exists in this workspace.` };
  }

  // Resolve + validate the built-in pot (kind:'hive') blueprint.
  const resolver = operatorResolveExtends({ localDirs: [] });
  const childObj: Record<string, unknown> = { id: opts.slug, extends: POT_BLUEPRINT_ID };
  const validation = resolveAndValidate(childObj, resolver);
  if (validation.parseError || !validation.ok || !validation.blueprint) {
    return {
      ok: false,
      error: 'blueprint_invalid',
      message: validation.parseError ?? 'the pot blueprint failed to resolve/validate',
    };
  }
  const requiresRepo = validation.blueprint.knobs.requiresRepo !== false;

  const parentDir = opts.parentDir ?? join(homedir(), '.papercusp', 'hives');
  const dest = resolvePath(join(parentDir, opts.slug));
  if (existsSync(dest)) {
    return { ok: false, error: 'dest_exists', message: `Destination already exists: ${dest}` };
  }

  // ── side effects begin: each pushes an undo; rollback runs them in reverse ──
  const undo: Array<() => Promise<void> | void> = [];
  const rollback = async () => {
    for (const u of undo.reverse()) {
      try {
        await u();
      } catch {
        /* best-effort cleanup */
      }
    }
  };

  try {
    // 1. Provision the dir (pot is normally repo-less; honor the blueprint knob).
    let path: string;
    if (requiresRepo) {
      const { initLocalHarnessDir } = await import('../../harness/init-local-dir');
      const init = await initLocalHarnessDir({ parentDir, folderName: opts.slug });
      path = init.path;
    } else {
      mkdirSync(dest, { recursive: true });
      path = dest;
    }
    undo.push(() => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    // 2. Register with harness_kind:'hive' (the marker resolveHive filters on —
    //    harness:create does NOT set this, so the hive path must).
    const fresh = await loadHarnessRegistry(ws);
    fresh.projects.push({
      slug: opts.slug,
      path,
      harness_kind: HIVE_KIND,
      ...(opts.deployment && opts.deployment.target !== 'local' ? { deployment: opts.deployment } : {}),
    });
    await saveHarnessRegistry(fresh, ws);
    undo.push(async () => {
      const r = await loadHarnessRegistry(ws);
      await saveHarnessRegistry(
        { ...r, projects: r.projects.filter((p) => p.slug !== opts.slug) },
        ws,
        { allowEmpty: true },
      );
    });

    // 3. Provision the harness PG schema (the inverse of dissolve's schema drop).
    const { scaffoldHarnessSchema } = await import('../../scaffold-harness-schema');
    await scaffoldHarnessSchema(opts.slug);
    undo.push(async () => {
      const { sql } = getOrgPg();
      await sql.unsafe(`DROP SCHEMA IF EXISTS harness_${opts.slug} CASCADE`).catch(() => {});
    });

    // 4. Write the git-canonical blueprint file (the pot blueprint).
    const bpDir = join(path, '.papercusp');
    mkdirSync(bpDir, { recursive: true });
    writeFileSync(join(bpDir, 'blueprint.yaml'), stringifyYaml(childObj, { lineWidth: 100 }), 'utf8');

    // 5. Materialize the pot blueprint's triggers (best-effort, like harness:create).
    try {
      const { materializeBlueprintTriggers } = await import('../../blueprint/materialize-triggers');
      await materializeBlueprintTriggers(opts.slug, validation.blueprint);
    } catch (e) {
      console.warn(`[hive:create] materialize triggers failed (${opts.slug}): ${e instanceof Error ? e.message : e}`);
    }

    // 6. Initial wake (optional): fire the Queen now, or declare a time wake.
    //    ROOT launch (no `parent`) — the no-nest guard passes for a parentless hive.
    let waked = false;
    if (opts.wakeInSeconds != null) {
      const kickoff =
        opts.kickoff ??
        `Hive '${opts.slug}' created. You are the Queen/operator in charge; survey the fleet and figure out what to do.`;
      if (opts.wakeInSeconds <= 0) {
        await fireLaunchBlueprint(POT_BLUEPRINT_ID, { installSlug: opts.slug, workspaceId: ws, kickoff });
        await recordPotWake(ws);
      } else {
        const { sql } = getOrgPg();
        await declarePotTimeWake(sql, {
          workspaceId: ws,
          installSlug: opts.slug,
          at: new Date(Date.now() + opts.wakeInSeconds * 1000),
          kickoff,
        });
      }
      waked = true;
    }

    return { ok: true, slug: opts.slug, path, waked };
  } catch (e) {
    await rollback();
    return { ok: false, error: 'create_failed', message: (e instanceof Error ? e.message : String(e)).slice(0, 400) };
  }
}
