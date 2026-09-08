/**
 * P-112 (deterministic-blueprints-migration-2026-06-13) — the MARKETPLACE
 * ROUND-TRIP for the migrated negative-space deterministic blueprint, end-to-end.
 *
 * The headline benefit of blueprint-izing a learning loop (the plan's "why",
 * D-001): unlike a baked-in lib+routine, a blueprint is a DISTRIBUTABLE artifact
 * — it can be EXPORTED into the Cupboard repo layout, INSTALLED on another
 * host/hive via the Cupboard install path, and RUN there. A lib+routine can
 * never travel like this. This proves that full cycle for the P-110 pilot
 * blueprint using the REAL machinery:
 *
 *   export  — package the bundled `negative-space` blueprint into the official
 *             multi-blueprint repo layout (<repo>/negative-space/blueprint.yaml),
 *             exactly the shape `scripts/publish-official-blueprints.mts sync`
 *             regenerates the public mirror (github.com/Papercusp/blueprints) from.
 *   install — `installBlueprintFromCupboardCore` (THE Cupboard install core the
 *             POST /api/cupboard/install-blueprint route wraps) clones + validates
 *             + places it under a FRESH installed-blueprints dir — a SECOND hive's
 *             installed tier, NOT this host's shared ~/.papercusp/blueprints.
 *   resolve — the composed local → installed → built-in resolver now finds the
 *             blueprint in the INSTALLED tier (it shadows the bundled built-in).
 *   run     — `runProgramCore` runs the installed copy's gateless program; the
 *             deterministic `negative-space:scan` step executes and reaches a
 *             clean `done` — and stays DARK (no-op) when its flag is off (D-004).
 *             The final case drives the PRODUCTION trigger end-to-end: the real
 *             `system:blueprint-run` handler resolves the INSTALLED copy (via the
 *             installed-tier launch resolver) and runs its program inline — the
 *             exact path a migrated loop's seed routine fires on its cadence.
 *
 * Only the git-clone binary is stubbed (copy the published repo dir) — the same
 * seam install-blueprint-core.test.ts + resolve-and-install.e2e.test.ts inject;
 * the install core, the composed resolver, and the program runner all run for
 * real, against the REAL bundled blueprint. The remaining LIVE leg — publishing a
 * kind=blueprint listing to the public Comb worker + cloning it from GitHub — is
 * outward-facing + credential-gated and waits on the staging→green deploy that
 * carries P-010/P-110; its recipe is recorded on the plan (P-112) for the owner.
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resolveBuiltinExtends, validateAgentInputClosure } from '@papercusp/orchestrator/blueprint';
import { makeComposedResolveExtends, resolveAndValidateBlueprint } from '@papercusp/blueprint-distribution';
import {
  installBlueprintFromCupboardCore,
  type InstallBlueprintCoreDeps,
} from '../cupboard/install-blueprint-core.js';
import '../coord-ops/index.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setNegativeSpaceScanDeps } from './ops/negative-space-scan.js';
import type { NegativeSpaceTickDeps } from '../negative-space/scan.js';
import { handleBlueprintRun, setBlueprintRunFire } from '../blueprint/blueprint-run-action.js';
import { setLaunchBlueprintResolver, setLaunchBlueprintFire } from '../blueprint/launch-blueprint.js';

/**
 * The bundled negative-space blueprint dir — the "export source". The official
 * mirror repo is regenerated FROM this bundle by `publish-official-blueprints.mts
 * sync`, so packaging this dir into a <repo>/<id>/ layout is a faithful export.
 */
const BUNDLED_BLUEPRINT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../libs/papercusp/packages/harness/blueprints/negative-space',
);

const GITHUB_URL = 'https://github.com/Papercusp/blueprints';

let root: string; // scratch root
let remoteRepo: string; // the "published" Cupboard repo (official multi-blueprint layout)
let installedDir: string; // a SECOND hive's installed-blueprints tier (~/.papercusp/blueprints stand-in)

/** Tick deps that never touch PG — a clean empty mine (mirrors the P-110 test). */
function fakeTickDeps(): NegativeSpaceTickDeps {
  return {
    readRows: async () => [],
    persist: async (_ws, entries) => entries,
    capture: async () => ({ created: false, possibleDuplicates: [], reason: 'stub' }) as never,
    markFiled: async () => {},
    log: () => {},
  };
}

/** A composed resolver over the second hive's installed tier + the bundled floor. */
function hive2Resolver() {
  return makeComposedResolveExtends({ installedDir, builtin: resolveBuiltinExtends });
}

/**
 * The install-core deps: stub ONLY the git binary (copy the published repo);
 * everything else is the real operator wiring against the test's own dirs.
 */
function makeDeps(): InstallBlueprintCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(remoteRepo, dest, { recursive: true });
    },
    installedBlueprintsDir: () => installedDir,
    tmpDir: () => root,
    resolveExtends: hive2Resolver(),
    // negative-space declares no tool/plugin deps, so this is never called; a
    // faithful empty host set keeps it honest if that ever changes.
    resolveHostSets: async () => ({
      availableTools: new Set<string>(),
      installedPlugins: new Set<string>(),
      cupboardPlugins: new Set<string>(),
      cupboardReachable: true,
    }),
  };
}

async function installIntoHive2() {
  return installBlueprintFromCupboardCore(
    { githubUrl: GITHUB_URL, listingRef: 'negative-space' },
    makeDeps(),
  );
}

/** Load the installed (marketplace) copy as a runnable, validated Blueprint. */
async function loadInstalled() {
  const raw = parseYaml(await fs.readFile(join(installedDir, 'negative-space', 'blueprint.yaml'), 'utf8'));
  const res = resolveAndValidateBlueprint(raw as Record<string, unknown>, hive2Resolver());
  assert.equal(res.ok, true, `installed copy failed validation: ${JSON.stringify(res.validation?.errors ?? res.parseError)}`);
  assert.ok(res.blueprint, 'installed copy did not parse to a blueprint');
  return res.blueprint!;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ns-roundtrip-'));
  remoteRepo = join(root, 'blueprints-repo'); // github.com/Papercusp/blueprints stand-in
  installedDir = join(root, 'hive2-blueprints'); // the 2nd hive's ~/.papercusp/blueprints
  // EXPORT: package the bundled blueprint into the official multi-blueprint repo
  // layout — <repo>/<listingRef>/blueprint.yaml — plus a .git dir to prove the
  // install excludes it.
  await fs.cp(BUNDLED_BLUEPRINT, join(remoteRepo, 'negative-space'), { recursive: true });
  await fs.mkdir(join(remoteRepo, '.git'), { recursive: true });
  await fs.writeFile(join(remoteRepo, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
});
afterEach(async () => {
  setNegativeSpaceScanDeps(null);
  setLaunchBlueprintResolver(null);
  setLaunchBlueprintFire(null);
  setBlueprintRunFire(null);
  await fs.rm(root, { recursive: true, force: true });
});

test('export source: the bundled negative-space blueprint exists on disk (sanity)', () => {
  assert.ok(existsSync(join(BUNDLED_BLUEPRINT, 'blueprint.yaml')), `missing ${BUNDLED_BLUEPRINT}`);
});

test('round-trip: a SECOND hive installs negative-space from the Cupboard and it shadows the built-in', async () => {
  const resolveExtends = hive2Resolver();
  // Before install: the fresh tier has nothing, so resolution falls through to
  // the bundled built-in floor (NOT the installed dir).
  const beforePath = resolveExtends('negative-space');
  assert.ok(beforePath, 'negative-space should resolve to the built-in floor pre-install');
  assert.ok(!beforePath!.startsWith(installedDir), 'pre-install must resolve to the built-in floor, not the installed tier');

  const res = await installIntoHive2();
  assert.equal(res.ok, true);
  assert.equal(res.id, 'negative-space');
  assert.equal(res.version, '0.1.0');
  assert.equal(res.abstract, false);
  assert.equal(res.installedTo, join(installedDir, 'negative-space'));
  assert.deepEqual(res.dependencies, { tools: [], packs: [], plugins: [], blueprints: [] });
  assert.ok(res.depCheck, 'even a dependency-free blueprint must return its replayable package-pin closure');
  assert.ok(res.depCheck.pins?.some((pin) => pin.packageKind === 'blueprint' && pin.ref === 'negative-space'));
  assert.doesNotThrow(() => validateAgentInputClosure(res.depCheck!.pins!));
  // Physically placed in the second hive's installed tier; .git excluded.
  assert.ok(existsSync(join(installedDir, 'negative-space', 'blueprint.yaml')));
  assert.ok(!existsSync(join(installedDir, 'negative-space', '.git')));

  // After install: the SAME resolver now finds it in the INSTALLED tier — the
  // marketplace copy shadows the bundled built-in (the distribution win).
  const afterPath = resolveExtends('negative-space');
  assert.equal(afterPath, join(installedDir, 'negative-space', 'blueprint.yaml'));
});

test('the installed (marketplace) copy resolves + validates as a gateless deterministic pipeline', async () => {
  await installIntoHive2();
  const blueprint = await loadInstalled();
  assert.equal(blueprint.id, 'negative-space');
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'negative-space:scan');
  // No gate ⇒ a deterministic pipeline (not a decision program).
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('it RUNS there: the marketplace-installed blueprint fires the deterministic step and reaches a clean done', async () => {
  setNegativeSpaceScanDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps: fakeTickDeps(),
  });
  await installIntoHive2();
  const blueprint = await loadInstalled();

  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'hive2-ws', harnessSlug: 'mktp-roundtrip-hive' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });

  assert.equal(out.outcome, 'done');
  assert.equal(out.resolved, true);
  // The deterministic step ran in the second hive and bound its typed result.
  const scan = out.scope?.scan as { ran: boolean; scanned?: number } | undefined;
  assert.equal(scan?.ran, true);
  assert.equal(scan?.scanned, 0);
});

test('dark stays dark in the second hive: flag OFF → the installed blueprint no-ops but the pipeline still completes (D-004)', async () => {
  setNegativeSpaceScanDeps({ flag: async () => false });
  await installIntoHive2();
  const blueprint = await loadInstalled();

  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'hive2-ws', harnessSlug: 'mktp-roundtrip-hive' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });

  assert.equal(out.outcome, 'done');
  const scan = out.scope?.scan as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(scan?.ran, false);
  assert.equal(scan?.skipReason, 'flag-off');
});

test('production fire path: the real system:blueprint-run handler resolves the INSTALLED copy and runs its program inline', async () => {
  await installIntoHive2();

  // In production the operator's launch resolver spans the installed/Cupboard
  // tier; point resolveLaunchBlueprint at the second hive's installed copy — the
  // exact resolution a Cupboard-installed launch blueprint gets (setLaunchBlueprintResolver
  // is the same seam the operator overrides for non-built-in launch blueprints).
  setLaunchBlueprintResolver(async (id) => {
    assert.equal(id, 'negative-space');
    const raw = parseYaml(await fs.readFile(join(installedDir, 'negative-space', 'blueprint.yaml'), 'utf8'));
    const res = resolveAndValidateBlueprint(raw as Record<string, unknown>, hive2Resolver());
    assert.ok(res.blueprint, 'installed launch blueprint failed to resolve');
    return res.blueprint!;
  });

  let ranTick = false;
  setNegativeSpaceScanDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps: {
      readRows: async () => {
        ranTick = true;
        return [];
      },
      persist: async (_ws, entries) => entries,
      capture: async () => ({ created: false, possibleDuplicates: [], reason: 'stub' }) as never,
      markFiled: async () => {},
      log: () => {},
    },
  });
  // Capture any decider/launch fire so we can prove a program blueprint fires NEITHER.
  const launchFired: unknown[] = [];
  setLaunchBlueprintFire((input) => { launchFired.push(input); });
  const deciderFired: unknown[] = [];
  setBlueprintRunFire((input) => { deciderFired.push(input); });

  // The exact SystemActionCtx the routine cadence dispatches for a migrated loop's
  // seed routine: payload_template { blueprintId: 'negative-space' }.
  await handleBlueprintRun({
    installSlug: 'mktp-roundtrip-hive',
    workspaceId: 'hive2-ws',
    triggerConfig: {},
    payloadTemplate: { blueprintId: 'negative-space' },
  });

  // The installed copy's deterministic step ran inline through the PRODUCTION
  // handler — and a program blueprint never fires a decider/launch.
  assert.equal(ranTick, true);
  assert.equal(launchFired.length, 0);
  assert.equal(deciderFired.length, 0);
});
