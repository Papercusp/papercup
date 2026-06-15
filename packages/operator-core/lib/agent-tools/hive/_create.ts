/**
 * createHiveHarness — provision a new local hive's home harness
 * (hive-tool-namespace-2026-06-08 P-004, D-005).
 *
 * Composes the SAME primitives `harness:create` uses (blueprint resolve+validate,
 * dir provision, registry, schema scaffold, blueprint.yaml, trigger
 * materialization) for the built-in `hive` (kind:'hive') blueprint — but with two
 * hive-specific differences:
 *   1. it stamps `harness_kind: 'hive'` on the registry entry (harness:create
 *      never sets harness_kind, so resolveHive could not otherwise find it), and
 *   2. it optionally fires the initial Queen wake (a ROOT, parentless launch).
 *
 * Transactional: each side effect pushes an undo onto a stack; a failure rolls
 * them back in reverse so a half-made hive (registered, no schema, dangling dir)
 * never lingers (D-005). The hive is a built-in blueprint with no external deps,
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
import { operatorResolveExtends, availableHiveBlueprintIds } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../blueprint/_resolve';
import { fireLaunchBlueprint } from '../../blueprint/launch-blueprint';
import { HIVE_BLUEPRINT_ID, declareHiveTimeWake, recordHiveWake } from '../../hive/wake';
import { HIVE_KIND } from './_resolve';

export interface CreateHiveOpts {
  slug: string;
  workspaceId: string;
  /** Parent dir for the home-harness folder. Default ~/.papercusp/hives. */
  parentDir?: string;
  deployment?: DeploymentConfig;
  /** Wake the Queen `wakeInSeconds` from now (0 = immediately). Omit ⇒ create
   *  idle (no wake declared; wake later via hive:wake / hive:declare-wake). */
  wakeInSeconds?: number;
  kickoff?: string;
  /**
   * Learning pack to seed into the hive's `hive:<slug>` memory pool
   * (learning-packs-2026-06-11 P-005). Omit ⇒ the default pack (D-004);
   * `null` ⇒ seed nothing. Flag-gated (LEARNING_PACKS) + best-effort —
   * a seed failure never fails the create.
   */
  learningPack?: string | null;
  /** Project shapes from blueprint detection — filters `applies_to`-tagged
   *  learnings (D-002). Omit (repo-less) ⇒ `any`-tagged items only. */
  projectShapes?: import('../../learning-packs/pack-format').AppliesTo[];
  /** metadata.created_by on seeded rows. Default 'system'. */
  createdBy?: string;
  /**
   * Provision the per-HIVE learning loop (gym + scout) at create
   * (per-hive-learning-loops P-020, D-003/D-008). `false` ⇒ skip; omit ⇒
   * provision when the PER_HIVE_LEARNING_LOOPS flag is on. Flag-gated +
   * best-effort — a provision failure warns and reports, never fails the create.
   */
  provisionLearningLoop?: boolean;
  /**
   * The kind:'hive' blueprint id to provision + launch (hive-blueprint-generalization
   * P-006). Default HIVE_BLUEPRINT_ID ('hive', the coding hive); 'generic-hive' for a
   * non-coding hive. Resolved local → installed → built-in.
   */
  blueprintId?: string;
}

export interface SeededLearningsSummary {
  packId: string;
  packVersion?: string;
  count?: number;
  error?: string;
}

export interface ProvisionedLoopSummary {
  /** The dark gym_autoloop_config row was laid down (enabled:false, budget:null). */
  gymAutoloop?: boolean;
  /** The inactive scout routine was laid down under the hive's install_slug. */
  scoutRoutine?: boolean;
  /** Per-cycle scout budget the routine carries (USD). */
  scoutMaxCostUsd?: number;
  error?: string;
}

export interface CreateHiveResult {
  ok: boolean;
  slug?: string;
  path?: string;
  waked?: boolean;
  /** Present when seeding was attempted (learning-packs P-005). */
  seededLearnings?: SeededLearningsSummary;
  /** Present when per-hive learning-loop provisioning was attempted (P-020). */
  provisionedLoop?: ProvisionedLoopSummary;
  error?: string;
  message?: string;
}

export async function createHiveHarness(opts: CreateHiveOpts): Promise<CreateHiveResult> {
  const ws = opts.workspaceId;

  const reg = await loadHarnessRegistry(ws);
  if (reg.projects.some((p) => p.slug === opts.slug)) {
    return { ok: false, error: 'slug_exists', message: `A harness '${opts.slug}' already exists in this workspace.` };
  }

  // Resolve + validate the chosen kind:'hive' blueprint (default the coding `hive`;
  // 'generic-hive' for a non-coding hive — hive-blueprint-generalization P-006).
  const blueprintId = opts.blueprintId ?? HIVE_BLUEPRINT_ID;
  const resolver = operatorResolveExtends({ localDirs: [] });
  const childObj: Record<string, unknown> = { id: opts.slug, extends: blueprintId };
  const validation = resolveAndValidate(childObj, resolver);
  if (validation.parseError || !validation.ok || !validation.blueprint) {
    return {
      ok: false,
      error: 'blueprint_invalid',
      message: validation.parseError ?? 'the hive blueprint failed to resolve/validate',
    };
  }
  // P-019: a hive MUST run a kind:'hive' blueprint — reject a harness blueprint
  // (e.g. `research`) passed by mistake, and surface the installable hive templates so
  // the choice is discoverable (the "selectable at create" picker's validation backbone).
  if (validation.blueprint.kind !== 'hive') {
    const choices = availableHiveBlueprintIds();
    return {
      ok: false,
      error: 'not_a_hive_blueprint',
      message:
        `Blueprint "${blueprintId}" is kind:'${validation.blueprint.kind}', not a hive — hive:create needs a ` +
        `kind:'hive' blueprint. Available hive blueprints: ${choices.length ? choices.join(', ') : '(none found)'}.`,
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
    // 1. Provision the dir (hive is normally repo-less; honor the blueprint knob).
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

    // 2b. Mint the Hive's first-class identity — a per-Hive Ed25519 keypair (secret
    //     in the OS keychain) + the entity row in PG (shared-hive-federation P-002;
    //     the pubkey is the dial-able id + federation topic key, P-003). Best-effort:
    //     a transient keychain/PG hiccup must not fail an otherwise-good create —
    //     resolveHive lazy-backfills the identity on first read. On success, push the
    //     undo so a later-step failure rolls the entity row back too.
    try {
      const { ensureHiveIdentity } = await import('../../hive-identity');
      await ensureHiveIdentity(ws, opts.slug);
      undo.push(async () => {
        const { deleteHive } = await import('../../hive-store');
        await deleteHive(ws, opts.slug).catch(() => {});
      });
    } catch (e) {
      console.warn(
        `[hive:create] hive identity mint failed (${opts.slug}); resolveHive will lazy-backfill it: ${e instanceof Error ? e.message : e}`,
      );
    }

    // 3. Provision the harness PG schema (the inverse of dissolve's schema drop).
    const { scaffoldHarnessSchema, dropHarnessSchema } = await import('../../scaffold-harness-schema');
    await scaffoldHarnessSchema(opts.slug);
    undo.push(async () => {
      await dropHarnessSchema(opts.slug).catch(() => {});
    });

    // 4. Write the git-canonical blueprint file (the hive blueprint).
    const bpDir = join(path, '.papercusp');
    mkdirSync(bpDir, { recursive: true });
    writeFileSync(join(bpDir, 'blueprint.yaml'), stringifyYaml(childObj, { lineWidth: 100 }), 'utf8');

    // 5. Materialize the hive blueprint's triggers (best-effort, like harness:create).
    try {
      const { materializeBlueprintTriggers } = await import('../../blueprint/materialize-triggers');
      await materializeBlueprintTriggers(opts.slug, validation.blueprint);
    } catch (e) {
      console.warn(`[hive:create] materialize triggers failed (${opts.slug}): ${e instanceof Error ? e.message : e}`);
    }

    // 6. Arm the Queen's DEFAULT event-wake subscriptions (start-hive-wake
    //    P-002 / D-001): plan-started / work-item-created / escalation-raised.
    //    REPLACE — a fresh hive has no tuned policy to preserve. Best-effort:
    //    hive:start re-affirms (ENSURE) so a transient failure here self-heals.
    try {
      const { armDefaultHiveWakeSubscriptions, blueprintWakeSubscriptions } = await import(
        '../../hive/wake-defaults'
      );
      // P-013: a hive blueprint may declare its own `wake.subscriptions`; absent
      // (today's coding hive + generic-hive) → the universal three defaults apply.
      // REPLACE here is the behavior-determining arm; hive:start's ENSURE preserves it.
      await armDefaultHiveWakeSubscriptions(ws, {
        mode: 'replace',
        subscriptions: blueprintWakeSubscriptions(validation.blueprint.wake),
      });
    } catch (e) {
      console.warn(
        `[hive:create] default wake-subscription arm failed (${opts.slug}): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 6b. Seed the selected learning pack into the hive's `hive:<slug>` memory
    //     pool (learning-packs P-005, D-001 copy-not-link). Flag-gated +
    //     best-effort: a seed failure warns and reports, never fails the
    //     create — but a LATER step failure rolls seeded rows back (the undo
    //     joins the stack). Runs before the first wake so the Queen's opening
    //     turn already recalls the pack.
    let seededLearnings: SeededLearningsSummary | undefined;
    if (opts.learningPack !== null) {
      try {
        const [{ getFlag }, { FLAGS }] = await Promise.all([
          import('@papercusp/flags/server'),
          import('@papercusp/flags'),
        ]);
        if (await getFlag(FLAGS.LEARNING_PACKS, 'system')) {
          const { DEFAULT_LEARNING_PACK_ID } = await import('../../learning-packs/pack-format');
          const { loadLearningPack } = await import('../../learning-packs/load-packs');
          const { seedPackIntoHive } = await import('../../learning-packs/seed');
          // P-014: an explicit arg wins; else the blueprint's declared learning.pack
          // (a generic-hive can seed a different pack); else the global default.
          const packId = opts.learningPack ?? validation.blueprint.learning?.pack ?? DEFAULT_LEARNING_PACK_ID;
          const loaded = await loadLearningPack(packId);
          if (!loaded) {
            seededLearnings = { packId, error: 'pack_not_found' };
            console.warn(`[hive:create] learning pack '${packId}' not found; seeding skipped (${opts.slug})`);
          } else {
            const res = await seedPackIntoHive({
              workspaceId: ws,
              hiveSlug: opts.slug,
              pack: loaded.pack,
              ...(opts.projectShapes ? { shapes: opts.projectShapes } : {}),
              ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
            });
            undo.push(res.undo);
            seededLearnings = {
              packId: res.packId,
              packVersion: res.packVersion,
              count: res.seeded,
              ...(res.error ? { error: res.error } : {}),
            };
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[hive:create] learning-pack seed failed (${opts.slug}): ${msg}`);
        seededLearnings = { packId: opts.learningPack ?? 'papercusp-default', error: msg.slice(0, 200) };
      }
    }

    // 6c. Provision this hive's OWN per-hive learning loop (per-hive-learning-loops
    //     P-020, D-003/D-008): a DARK gym_autoloop_config row + an INACTIVE scout
    //     routine, BOTH keyed to the hive's own install_slug (NOT @singleton —
    //     that's reserved for the workspace-singleton frontier loops, D-008). Both
    //     ship inert (the gym tick doubly refuses a disabled+unbudgeted row; an
    //     inactive routine never fires) — the owner arms each via the gym/routines
    //     UI. Same contract as the learning-pack seed above: flag-gated +
    //     best-effort (a failure warns and reports, NEVER fails the create), and a
    //     LATER step failure rolls the rows back (the undo joins the stack). The
    //     matching teardown at hive:dissolve is P-021.
    let provisionedLoop: ProvisionedLoopSummary | undefined;
    if (opts.provisionLearningLoop !== false) {
      try {
        const [{ getFlag }, { FLAGS }] = await Promise.all([
          import('@papercusp/flags/server'),
          import('@papercusp/flags'),
        ]);
        if (await getFlag(FLAGS.PER_HIVE_LEARNING_LOOPS, 'system')) {
          const { provisionHiveLearningLoop } = await import('../../hive/provision-learning-loop');
          const { sql } = getOrgPg();
          const res = await provisionHiveLearningLoop({ sql, workspaceId: ws, hiveSlug: opts.slug });
          undo.push(res.undo);
          provisionedLoop = {
            gymAutoloop: res.gymAutoloop,
            scoutRoutine: res.scoutRoutine,
            ...(res.scoutMaxCostUsd != null ? { scoutMaxCostUsd: res.scoutMaxCostUsd } : {}),
            ...(res.error ? { error: res.error } : {}),
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[hive:create] per-hive learning-loop provision failed (${opts.slug}): ${msg}`);
        provisionedLoop = { error: msg.slice(0, 200) };
      }
    }

    // 7. Initial wake (optional): fire the Queen now, or declare a time wake.
    //    ROOT launch (no `parent`) — the no-nest guard passes for a parentless hive.
    let waked = false;
    if (opts.wakeInSeconds != null) {
      const seededNote =
        seededLearnings && !seededLearnings.error && (seededLearnings.count ?? 0) > 0
          ? ` Your hive's shared memory was pre-seeded with ${seededLearnings.count} learnings from the '${seededLearnings.packId}' pack — starting wisdom, editable, not gospel; run convention discovery to bind its discovery rules to this project.`
          : '';
      const kickoff =
        opts.kickoff ??
        `Hive '${opts.slug}' created. You are the Queen/operator in charge; survey the fleet and figure out what to do.${seededNote}`;
      if (opts.wakeInSeconds <= 0) {
        await fireLaunchBlueprint(blueprintId, { installSlug: opts.slug, workspaceId: ws, kickoff });
        await recordHiveWake(ws);
      } else {
        const { sql } = getOrgPg();
        await declareHiveTimeWake(sql, {
          workspaceId: ws,
          installSlug: opts.slug,
          at: new Date(Date.now() + opts.wakeInSeconds * 1000),
          kickoff,
          blueprintId,
        });
      }
      waked = true;
    }

    return {
      ok: true,
      slug: opts.slug,
      path,
      waked,
      ...(seededLearnings ? { seededLearnings } : {}),
      ...(provisionedLoop ? { provisionedLoop } : {}),
    };
  } catch (e) {
    await rollback();
    return { ok: false, error: 'create_failed', message: (e instanceof Error ? e.message : String(e)).slice(0, 400) };
  }
}
