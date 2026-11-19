/**
 * Every worker script that resolves its own path NEXT TO the executing module
 * must be staged beside the entry by EVERY bundler that produces one.
 *
 * WHY THIS GUARD EXISTS. This failure has now happened FOUR times, each time to
 * a different worker or a different bundler, and every time silently:
 *
 *  - WI-4196 — `local-embedder-worker.script.mjs` missing from the host bundle,
 *    so every embed fell back to inline main-thread ONNX (~6s vs ~36ms).
 *  - EI-19465075959589134 — `cpu-task-worker.script.mjs`, same class, labelled
 *    in bundle-host.sh itself as "SAME CLASS AS WI-4196 ABOVE, missed for this
 *    worker". :3170 ran at p95 1920ms, 87.5% GC, for an unknown period.
 *  - WI-37555 — `local-reranker-worker.script.mjs`, added with this test.
 *  - WI-37555 again, and this is the one that motivates the SECOND bundler
 *    below: the DESKTOP sidecar build (`build-desktop-sidecar.sh`) copied NONE
 *    of them. Measured on the 2026-08-09 06:06 build, `serve.mjs` referenced
 *    `local-embedder-worker.script.mjs` while no `*.script.mjs` existed beside
 *    it at all — so WI-4196's fix had never reached a packaged desktop install,
 *    the actual shipping target.
 *
 * The shape is always identical and is why hand-memory keeps losing to it:
 * `new Worker(resolve(dirname(here), '…script.mjs'))` works perfectly in the dev
 * tree (the script IS next to the module) and fails only in a BUNDLE, where
 * esbuild emits no sibling non-JS assets. Every one of these workers has a
 * deliberate inline fallback, so the failure never throws, never logs by
 * default, and reads as "working, just slow".
 *
 * The invariant is anchored to the PROPERTY that defines membership — a
 * `*.script.mjs` living in a source tree, checked against every bundler — not to
 * a hand-kept list of known workers, which is the form-blind mistake that let
 * instances two and four through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join, relative, resolve } from 'node:path';
import { testImportClosures } from './agent-tools/testing/mutation-probe-fence';
import { localEsbuildNpxPath } from './test-fixtures/local-esbuild-npx';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Overridable so falsifiability can be proven against a COPY outside the tree
 *  (`scripts/mutation-probe.sh`) instead of mutating the shared checkout, where
 *  git-sync would commit the mutant mid-probe. */
const BUNDLERS: { label: string; path: string }[] = [
  {
    label: 'apps/operator/bin/bundle-host.sh (host + operator sidecar bundles)',
    path: process.env.PROBE_BUNDLE_SCRIPT ?? join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh'),
  },
  {
    label: 'papercusp-desktop/bin/build-desktop-sidecar.sh (packaged desktop app)',
    path:
      process.env.PROBE_DESKTOP_SCRIPT ??
      join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh'),
  },
  {
    label: 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh (current-build rig)',
    path: join(REPO_ROOT, 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh'),
  },
];

/** Worker entries whose bundlers must compile their import graph instead of
 * copying a sibling `.script.mjs` asset. */
const ESBUILD_WORKERS: { source: string; output: string }[] = [
  {
    source: 'packages/operator-core/lib/event-loop-sentinel.worker.ts',
    output: 'event-loop-sentinel.worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/sync/hyperbee/snapshot-fold.worker.ts',
    output: 'snapshot-fold.worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/agent-tools/testing/mutation-probe-closure.worker.ts',
    output: 'mutation-probe-closure.worker.mjs',
  },
  {
    // WI-10005223: frozen-repair admission git off the operator main thread.
    source: 'packages/operator-core/lib/release/admission-jobs.worker.ts',
    output: 'admission-jobs.worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/memory/bench/precision-bench-worker.ts',
    output: 'precision-bench-worker.mjs',
  },
  {
    // WI-10006543: graph:query callers, one forked process per question.
    source: 'packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts',
    output: 'first-party-callers.worker.mjs',
  },
  {
    // WI-10005186: keep Codex-home filesystem materialization off request loops.
    source: 'packages/operator-core/lib/role-codex-home.worker.ts',
    output: 'role-codex-home.worker.mjs',
  },
  {
    // WI-6554700010030353: the resident full-window co-change index, one child per repository.
    source: 'packages/operator-core/lib/code-intelligence/warm-cochange-index.worker.ts',
    output: 'warm-cochange-index.worker.mjs',
  },
  {
    // The independent census imports TS; copying its .mjs launcher is insufficient.
    source: 'libs/test-config/src/verifier-source-worker.mjs',
    output: 'verifier-source-worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/agent-tools/testing/testing-core.worker.ts',
    output: 'testing-core.worker.mjs',
  },
];

/**
 * Required sibling runtime assets that do not use the `*.script.mjs` worker
 * naming convention and therefore cannot be discovered by findWorkerScripts.
 *
 * EI-21306004866205635: systemd-scope.ts resolves this file with
 * `new URL('./systemd-scope-env-runner.mjs', import.meta.url)`.  That works in
 * the source tree and fails only after esbuild collapses operator-core into a
 * different directory.  The release host then accepted systemd units whose
 * payloads immediately failed MODULE_NOT_FOUND; every cluster worker retried
 * its spawner sidecar and the MCP proxy repeatedly exhausted its 8s upstream
 * header budget.  Both bundlers must publish the asset beside their entry.
 */
const BUNDLE_HOST_COMMON = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');

/**
 * DERIVED from the shared recipe's HOST_RUNTIME_SIBLING_SOURCES, not a second
 * hand-kept copy: this list used to name only the systemd runner, so a builder
 * that dropped git-ext-bridge.mjs stayed green while every same-box hive-git
 * fetch died "Cannot find module" (WI-10003976). The positive-control test
 * below keeps a broken parse from making every assertion vacuous.
 */
function runtimeSiblingAssets(): { source: string; output: string }[] {
  const text = readFileSync(BUNDLE_HOST_COMMON, 'utf8');
  const block = /^HOST_RUNTIME_SIBLING_SOURCES=\(([\s\S]*?)^\)/m.exec(text)?.[1] ?? '';
  return block
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('#'))
    .map((source) => ({ source, output: source.slice(source.lastIndexOf('/') + 1) }));
}
const REQUIRED_RUNTIME_SIBLING_ASSETS = runtimeSiblingAssets();

/** Directories holding BUILD OUTPUT or vendored code, where a `*.script.mjs` is
 *  a COPY produced by the very step under test — counting those would let this
 *  guard pass by observing its own output. */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-host',
  'dist-sidecar',
  '.next',
  'build',
  'out',
  'target',
  '_retired',
  'sidecar',
  'env-sidecars',
  'coverage',
  // Gitignored agent state: scratch probes and isolation worktrees, never this
  // tree's sources. Measured 2026-10-01: a peer's
  // .papercusp/scratch/wi5070-worker-unload.script.mjs turned all three
  // "stages every source *.script.mjs" cases red in the shared tree only.
  '.papercusp',
]);

function findWorkerScripts(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findWorkerScripts(full, found);
    else if (entry.endsWith('.script.mjs')) found.push(full);
  }
  return found;
}

/**
 * Lines that actually DO something — comments stripped.
 *
 * A bare `includes(basename)` over the whole file is satisfied by a comment
 * MENTIONING the worker, so it would pass for a script that is documented but
 * never copied. Verified under mutation-probe: deleting the rerank `cp` left the
 * basename sitting in its own explanatory comment, and a whole-file check did
 * NOT go red. Stripping comments is what makes the check mean "is staged"
 * rather than "is discussed" — while still accepting BOTH staging forms in use
 * (a literal `cp … "$OUTDIR/<name>"`, and a loop over a list of source paths).
 */
function executableText(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function bundlerExecutable(file: string): string {
  const source = executableText(readFileSync(file, 'utf8'));
  // A shared recipe counts only when the caller actually sources and invokes it.
  if (/^source .*bundle-host-common\.sh/m.test(source) && /^bundle_host_workers /m.test(source)) {
    return source + '\n' + executableText(readFileSync(join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh'), 'utf8'));
  }
  return source;
}

/** The sibling stager counts only when this builder sources AND invokes it —
 *  bundle_host_workers alone must not lend a builder the sibling names. */
function siblingExecutable(file: string): string {
  const source = executableText(readFileSync(file, 'utf8'));
  if (/^source .*bundle-host-common\.sh/m.test(source) && /^bundle_host_runtime_siblings /m.test(source)) {
    return source + '\n' + executableText(readFileSync(BUNDLE_HOST_COMMON, 'utf8'));
  }
  return source;
}

describe('shared worker recipe executes in the bundled plain-node runtime', () => {
  let output: string;
  let gateMeta: string;
  let compilerPath: string;
  let buildOutput: string;
  const recipe = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');
  // WI-6554700010048806: a witnessed worker build takes minutes under real fleet load, not 30s.
  // Every build() call starts with a full testing-core witness prepare. Measured 2026-11-15 with
  // IO pressure full avg60 8-14: the whole build took 79s and 106s, and the prepare alone took 62s
  // and 84s (snapshot copy 37.5s, discovery 13.7s, final 8.5s; package-cache lock wait 0.24s).
  // The witness helper itself allows its native discovery compile 120s. coreutils `timeout`
  // signals the build's whole process group when the budget expires, so no esbuild or node
  // grandchild outlives a failed attempt; spawnSync's own timeout is only the backstop.
  const BUILD_BUDGET_SEC = 240;
  const BUILD_TEST_TIMEOUT_MS = (BUILD_BUDGET_SEC + 30) * 1000;
  const budgetedBash = (args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
    spawnSync('timeout', ['--kill-after=10', String(BUILD_BUDGET_SEC), 'bash', ...args],
      { ...options, timeout: (BUILD_BUDGET_SEC + 20) * 1000 });
  const budgetNote = (status: number | null) => status === 124
    ? `the ${BUILD_BUDGET_SEC}s build budget expired and timeout killed the build's process group; ` : '';
  const build = (extraEnv: NodeJS.ProcessEnv = {}, subject = recipe, destination = output) => budgetedBash([
    '-c', 'set -euo pipefail; source "$1"; bundle_host_workers "$2" "$3" "${PAPERCUSP_EMBED_WORKER_SCRIPT:-}"; printf "\\nTESTING_CORE_BINDING %s\\n" "$BUNDLE_HOST_TESTING_CORE_BINDING"', 'worker-recipe-test', subject, REPO_ROOT, destination,
  ], {
    cwd: REPO_ROOT,
    // The pinned fixture resolves once before this build. Exercise the recipe's
    // lease calls in a private domain, so real maintenance cannot delay it.
    env: { ...process.env, PATH: compilerPath, PAPERCUSP_FS_MUTEX_LOCK_DIR: join(output, 'package-cache-locks'),
      BUNDLE_HOST_STEP_LOG: join(destination, 'bundle-host.steps.tsv'),
      PAPERCUSP_EMBED_WORKER_SCRIPT: '', BUNDLE_HOST_GATE_META_DIR: join(destination, 'missing-gate-meta'), ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });

  beforeAll(() => {
    output = mkdtempSync(join(tmpdir(), 'bundled-workers-'));
    compilerPath = localEsbuildNpxPath(join(output, 'local-compiler'), REPO_ROOT);
    // EI-24917607035361603: the real staging caller set this path without
    // creating it. Exercise that boundary in the same real worker build.
    gateMeta = join(output, 'missing-gate-meta');
    expect(existsSync(gateMeta)).toBe(false);
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(output, 'node_modules'), 'dir');
    const result = build();
    const stepLog = join(output, 'bundle-host.steps.tsv');
    const steps = existsSync(stepLog) ? readFileSync(stepLog, 'utf8') : 'No bundle steps recorded';
    expect(result.error, `worker fixture signal=${result.signal}; ${result.stdout + result.stderr}\n${steps}`).toBeUndefined();
    expect(result.status, `${budgetNote(result.status)}${result.stdout + result.stderr}\n${steps}`).toBe(0);
    buildOutput = result.stdout + result.stderr;
  }, BUILD_TEST_TIMEOUT_MS);

  afterAll(() => {
    if (output) rmSync(output, { recursive: true, force: true });
  });

  // WI-6554700010020817 made cpu-task-worker.script.mjs an esbuild compile (its own branch in
  // bundle_host_workers), so a `.script.mjs` source can be compiled too. Derive those from the
  // recipe rather than hand-count them: a hand count went stale the day that branch landed.
  const esbuiltScriptWorkers = () => [...readFileSync(recipe, 'utf8')
    .matchAll(/if \[ "\$output" = "([^"]+\.script\.mjs)" \]; then\n(?:.*\n){0,6}?.*bundle_host_esbuild "\$repo_root" "\$source"/g)]
    .map(match => match[1]!);

  function compiledTestingCoreParent() {
    const retained = buildOutput.split('\n').find(line => line.startsWith('TESTING_CORE_BINDING '));
    expect(retained, buildOutput).toBeTruthy();
    // The producing shell retained this expectation before the parent build;
    // it is not reconstructed from the sibling the parent will execute.
    const binding = JSON.parse(retained!.slice('TESTING_CORE_BINDING '.length));
    const parent = join(output, 'testing-parent.mjs');
    if (existsSync(parent)) return { parent, binding };
    const command = [
      'set -euo pipefail; source "$1";',
      'BUNDLE_HOST_TESTING_CORE_RECEIPT="$3/testing-core.worker.witness.json";',
      'BUNDLE_HOST_TESTING_CORE_BINDING="$4"; bundle_host_verify_testing_core "$2";',
      'boundary=("${HOST_COMMON_EXTERNALS[@]}"); for name in "${NATIVE_PKGS[@]}"; do boundary+=("--external:$name"); done;',
      'bundle_host_esbuild "$2" "$2/packages/operator-core/lib/agent-tools/testing/run.ts" --bundle --platform=node --format=esm --target=node22',
      '--define:__PAPERCUSP_BUNDLED_SIDECAR__=true --banner:js="$HOST_BANNER" "${HOST_BANNER_DEFINES[@]}" "${boundary[@]}" "$5" --outfile="$3/testing-parent.mjs";',
      'node "$2/apps/operator/bin/ascii-escape-bundle.mjs" "$3/testing-parent.mjs" --check;',
      'bundle_host_verify_testing_core "$2";',
    ].join(' ');
    const built = budgetedBash(['-c', command, 'testing-core-parent', recipe, REPO_ROOT, output,
      JSON.stringify(binding), '--define:__PAPERCUSP_TESTING_CORE_WITNESS__=' + JSON.stringify(binding.witness)], {
      cwd: REPO_ROOT, env: { ...process.env, PATH: compilerPath,
        PAPERCUSP_FS_MUTEX_LOCK_DIR: join(output, 'package-cache-locks') }, encoding: 'utf8',
    });
    expect(built.status, budgetNote(built.status) + built.stdout + built.stderr).toBe(0);
    return { parent, binding };
  }

  it('automatically selects the actual witnessed sibling and refuses its absence before child start or report allocation', () => {
    const { parent } = compiledTestingCoreParent();
    const script = [
      'import * as modules from "node:module"; import fs from "node:fs"; import cp from "node:child_process"; import {dirname} from "node:path";',
      'const parent=await import(process.argv[1]);',
      'const opts={root:process.argv[3],files:["packages/operator-core/lib/worker-scripts-bundled.test.ts"],privatePg:false,',
      'deadline:{startedAtMs:Date.now(),taskDeadlineAtMs:Date.now()+60000,childCutoffAtMs:Date.now()+50000,cleanupReserveMs:10000}};',
      // WI-6554700010048806: 6f0a12c9284 made the builder async and moved its report allocation to
      // node:fs/promises mkdtemp, so an mkdtempSync-only counter silently counted nothing. Count both
      // APIs, and require the counter to observe the accepted build's own allocation before trusting 0.
      'let allocations=0,starts=0,missing; const make=fs.mkdtempSync,makeAsync=fs.promises.mkdtemp;',
      'fs.mkdtempSync=(...args)=>{allocations++;return make(...args)};',
      'fs.promises.mkdtemp=(...args)=>{allocations++;return makeAsync(...args)}; modules.syncBuiltinESMExports();',
      'const request=await parent.buildDetachedTestRunRequest(opts);',
      'const allocationCounterWorks=allocations>0;allocations=0;',
      'for(const row of request.detachedReportArtifacts) fs.rmSync(dirname(row.reportPath),{recursive:true,force:true});',
      'const launchMethods=["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"];',
      'const originals=Object.fromEntries(launchMethods.map(name=>[name,cp[name]])); const nativeSpawn=cp.ChildProcess.prototype.spawn;',
      'for(const name of launchMethods)cp[name]=function(...args){starts++;return Reflect.apply(originals[name],this,args)};',
      'cp.ChildProcess.prototype.spawn=function(...args){starts++;return Reflect.apply(nativeSpawn,this,args)};modules.syncBuiltinESMExports();',
      'const control=cp.spawnSync(process.execPath,["-e","process.exit(0)"],{encoding:"utf8"});',
      'const counterWorks=control.status===0&&starts>0;starts=0;',
      'fs.renameSync(process.argv[2],process.argv[2]+".held");',
      'try{await parent.buildDetachedTestRunRequest(opts)}catch(error){missing=error.code}',
      'finally{fs.renameSync(process.argv[2]+".held",process.argv[2]);fs.mkdtempSync=make;fs.promises.mkdtemp=makeAsync;',
      'for(const name of launchMethods)cp[name]=originals[name];cp.ChildProcess.prototype.spawn=nativeSpawn;modules.syncBuiltinESMExports()}',
      'console.log("AUTOMATIC_TESTING_CORE "+JSON.stringify({args:request.args.slice(0,2),sourceLoader:request.args.includes("tsx"),',
      'retainedGuard:request.env.NODE_OPTIONS.startsWith("--import="),missing,allocations,starts,counterWorks,allocationCounterWorks}));process.exit(0);',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      parent, join(output, 'testing-core.worker.mjs'), REPO_ROOT], { encoding: 'utf8', timeout: 90_000 });
    // WI-6554700010048806: under fleet IO pressure loading the produced core took longer than the
    // old 20s, and spawnSync killed the child (status null) with no output.
    expect(result.status, `signal=${result.signal}; ${result.stdout + result.stderr}`).toBe(0);
    const line = result.stdout.split('\n').find(value => value.startsWith('AUTOMATIC_TESTING_CORE '));
    expect(line, result.stdout + result.stderr).toBeTruthy();
    expect(JSON.parse(line!.slice('AUTOMATIC_TESTING_CORE '.length))).toMatchObject({
      args: ['--input-type=module', '-e'], sourceLoader: false, retainedGuard: true,
      missing: 'testing_core_missing_artifact', allocations: 0, starts: 0, counterWorks: true,
      allocationCounterWorks: true,
    });
  }, BUILD_TEST_TIMEOUT_MS);

  it('holds the shared package-cache reader for every actual worker compiler invocation', () => {
    expect(esbuiltScriptWorkers()).toEqual(['cpu-task-worker.script.mjs']);
    const guarded = buildOutput.split('\n').filter(value => value.includes('NPM_INSTALL_SAFE guarding package-cache reader:'));
    expect(guarded.length, guarded.join('\n'))
      .toBe(ESBUILD_WORKERS.length + esbuiltScriptWorkers().length + 2); // pin resolution, guest bootstrap, workers
  });

  it('emits the handler guest entry as standalone CommonJS accepted by plain Node', () => {
    const guest = join(output, 'handler-bootstrap.cjs');
    expect(existsSync(guest)).toBe(true);
    const result = spawnSync(process.execPath, ['--check', guest], { encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('verifies independent source through the bundled reader and its actual sibling worker', () => {
    const sourceRoot = join(output, 'verifier-archive');
    mkdirSync(sourceRoot);
    const source = 'export const value = 1;\n';
    writeFileSync(join(sourceRoot, 'source.ts'), source);
    const file = { path: 'source.ts', kind: 'file', executable: false,
      sha256: createHash('sha256').update(source).digest('hex') };
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40),
      files: [file], testedInputs: [{ path: file.path, sha256: file.sha256 }] };
    const receiptPath = join(output, 'independent-verifier-receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(sourceRoot, '.verifier-source.json'), JSON.stringify(receipt));
    const entry = join(output, 'verifier-parent.ts');
    const parent = join(output, 'verifier-parent.mjs');
    writeFileSync(entry, 'export { readVerifierSourceReceipt } from '
      + JSON.stringify(join(REPO_ROOT, 'libs/test-config/src/verifier-source.ts')) + ';\n');
    const built = budgetedBash(['-c',
      'set -euo pipefail; source "$1"; bundle_host_esbuild "$2" "$3" --bundle --platform=node --format=esm --target=node22 --outfile="$4"',
      'verifier-parent', recipe, REPO_ROOT, entry, parent], {
      cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PATH: compilerPath,
        PAPERCUSP_FS_MUTEX_LOCK_DIR: join(output, 'package-cache-locks') },
    });
    expect(built.status, budgetNote(built.status) + built.stdout + built.stderr).toBe(0);
    const script = [
      'import {writeFileSync,renameSync} from "node:fs";',
      'const {readVerifierSourceReceipt}=await import(process.argv[2]);',
      'const root=process.argv[3], receiptPath=process.argv[4], worker=process.argv[5];',
      'const receipt=await readVerifierSourceReceipt(root,receiptPath);',
      'writeFileSync(root+"/source.ts","export const value = 2;\\n");',
      'let tampered,missing;',
      'try{await readVerifierSourceReceipt(root,receiptPath)}catch(error){tampered=error.message}',
      'renameSync(worker,worker+".held");',
      'try{await readVerifierSourceReceipt(root,receiptPath)}catch(error){missing=error.code}',
      'finally{renameSync(worker+".held",worker)}',
      'console.log(JSON.stringify({receipt,tampered,missing}));',
    ].join('\n');
    // File workers inherit execArgv; launch a plain ESM file so --input-type
    // cannot leak from an eval parent into the actual sibling worker.
    const runner = join(output, 'verifier-runner.mjs');
    writeFileSync(runner, script);
    const result = spawnSync(process.execPath, [runner,
      parent, sourceRoot, receiptPath, join(output, 'verifier-source-worker.mjs')], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env,
        VERIFY_TAURI_SOURCE_REF: receipt.sourceCommit },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ receipt,
      tampered: expect.stringContaining('changed source.ts'), missing: 'MODULE_NOT_FOUND' });
  }, BUILD_TEST_TIMEOUT_MS);

  it('control: successful compilation without the package-cache lease is detected', () => {
    const original = readFileSync(recipe, 'utf8');
    const guarded = 'bundle_host_esbuild "$repo_root" "$source"';
    // Guest bootstrap, TypeScript loop, and each esbuilt `.script.mjs` branch.
    expect(original.split(guarded)).toHaveLength(3 + esbuiltScriptWorkers().length);
    const subject = join(output, 'recipe-without-cache-lease.sh');
    writeFileSync(subject, original.replaceAll(guarded, 'npx --yes esbuild@0.25.0 "$source"'));
    const result = build({}, subject, join(output, 'cache-lease-control'));
    expect(result.error, `worker control signal=${result.signal}; ${result.stdout + result.stderr}`).toBeUndefined();
    expect(result.status, budgetNote(result.status) + result.stdout + result.stderr).toBe(0);
    // The separately prepared core still owns its resolution + API leases;
    // the mutated remaining worker invocations have lost theirs.
    expect((result.stdout + result.stderr).match(/NPM_INSTALL_SAFE guarding package-cache reader:/g) ?? [])
      .toHaveLength(2);
  }, BUILD_TEST_TIMEOUT_MS);

  it('loads the actual produced testing core and refuses its expired cutoff before a child or packet exists', () => {
    const artifactBaseDir = join(output, 'expired-core-artifacts');
    const script = [
      'import * as modules from "node:module";',
      'import {createRequire} from "node:module";',
      'import {existsSync} from "node:fs";',
      'const core = await import(process.argv[1]);',
      'const cp=createRequire(import.meta.url)("node:child_process");',
      'const calls=[];',
      'for(const name of ["spawn","spawnSync","fork","exec","execFile","execSync","execFileSync"])',
      '  cp[name]=()=>{calls.push(name);throw new Error("expired core started a child");};',
      'modules.syncBuiltinESMExports();',
      `const result=await core.runTestFilesCore({files:["packages/operator-core/lib/agent-tools/testing/run-loop-gate.test.ts"],root:${JSON.stringify(REPO_ROOT)},privatePg:false,`,
      '  deadline:{startedAtMs:1,taskDeadlineAtMs:2,cleanupReserveMs:0,childCutoffAtMs:2}},',
      `  {artifactBaseDir:${JSON.stringify(artifactBaseDir)}});`,
      `console.log("EXPIRED_COMPILED_CORE "+JSON.stringify({result,calls,packetExists:existsSync(${JSON.stringify(artifactBaseDir)}),source:core.testingCoreSourceSha256,api:typeof core.runTestFilesCore}));`,
      'process.exit(result.error === "deadline_exhausted" && calls.length===0 ? 0 : 1);',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      join(output, 'testing-core.worker.mjs')], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const line = result.stdout.split('\n').find(value => value.startsWith('EXPIRED_COMPILED_CORE '));
    expect(line, result.stdout + result.stderr).toBeTruthy();
    const observed = JSON.parse(line!.slice('EXPIRED_COMPILED_CORE '.length));
    const receipt = JSON.parse(readFileSync(join(output, 'testing-core.worker.witness.json'), 'utf8'));
    expect(observed).toMatchObject({ api: 'function', source: receipt.witness.sourceSha256,
      calls: [], packetExists: false, result: { ok: false, error: 'deadline_exhausted' } });
  });

  it('executes the actual compiled sibling without rebinding an occupied host port', () => {
    const { parent, binding } = compiledTestingCoreParent();
    const host = join(output, 'occupied-testing-host.mjs');
    writeFileSync(host, [
      'export {buildDetachedTestRunRequest} from ' + JSON.stringify(parent) + ';',
      'import {createServer} from "node:net";',
      'const host=createServer(); await new Promise((resolve,reject)=>{host.once("error",reject);',
      'host.listen(Number(process.env.TEST_RECOVERY_HOST_PORT||0),"127.0.0.1",resolve)});',
      'process.env.TEST_RECOVERY_HOST_PORT=String(host.address().port); globalThis.recoveryTestHost=host;',
    ].join('\n'));
    const script = [
      'import {spawnSync} from "node:child_process"; import {rmSync} from "node:fs"; import {dirname} from "node:path";',
      'const parent=await import(process.argv[1]); let request;',
      // WI-6554700010048806: the control re-imports the compiled parent, which took longer than
      // the old 10s under fleet IO pressure (status null, no EADDRINUSE). Run it before the
      // request's deadline starts, so a slow control cannot eat the real child's budget.
      'try { const control=spawnSync(process.execPath,["--input-type=module","-e","await import("+JSON.stringify(process.argv[1])+");"],',
      '{env:process.env,encoding:"utf8",timeout:60000});',
      'const now=Date.now(); request=await parent.buildDetachedTestRunRequest({root:process.argv[2],',
      'files:["unused-compiled-core-fixture.test.ts"],privatePg:false,',
      'deadline:{startedAtMs:now,taskDeadlineAtMs:now+60000,childCutoffAtMs:now+50000,cleanupReserveMs:10000}});',
      'const child=spawnSync(request.command,request.args,{cwd:request.cwd,env:{...process.env,...request.env},encoding:"utf8",timeout:40000});',
      'console.log("COMPILED_OCCUPIED "+JSON.stringify({args:request.args,status:child.status,stdout:child.stdout,stderr:child.stderr,',
      'error:child.error?.message,controlStatus:control.status,controlStderr:control.stderr,controlError:control.error?.message,',
      'hostStillListening:globalThis.recoveryTestHost.listening}));',
      '} finally {for(const row of request?.detachedReportArtifacts??[])rmSync(dirname(row.reportPath),{recursive:true,force:true});',
      'globalThis.recoveryTestHost.close()}',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, host, REPO_ROOT], {
      cwd: REPO_ROOT, env: process.env, encoding: 'utf8', timeout: 150_000,
    });
    expect(child.status, `signal=${child.signal}; ${child.stdout + child.stderr}`).toBe(0);
    const line = child.stdout.split('\n').find(row => row.startsWith('COMPILED_OCCUPIED '));
    expect(line, child.stdout + child.stderr).toBeTruthy();
    const observed = JSON.parse(line!.slice('COMPILED_OCCUPIED '.length));
    expect(observed, `controlError=${observed.controlError}; controlStderr=${observed.controlStderr}`)
      .toMatchObject({ controlStatus: 1, hostStillListening: true, status: 1 });
    expect(observed.error).toBeUndefined();
    expect(observed.controlError).toBeUndefined();
    expect(observed.controlStderr).toContain('EADDRINUSE');
    expect(observed.stderr).not.toContain('EADDRINUSE');
    expect(observed.args.slice(0, 2)).toEqual(['--input-type=module', '-e']);
    const phases = observed.stderr.split('\n').map((row: string) => {
      try { return JSON.parse(row); } catch { return null; }
    }).filter((row: any) => row?.schemaVersion === 'testing-run-bootstrap-v1');
    let previous = -1;
    for (const phase of ['core-import-start', 'core-import-complete', 'core-witness-verified',
      'core-execution-start', 'core-execution-complete']) {
      const matches = phases.filter((row: any) => row.phase === phase);
      expect(matches, 'missing/duplicate actual compiled bootstrap phase: ' + phase).toHaveLength(1);
      const index = phases.indexOf(matches[0]);
      expect(index, 'compiled bootstrap phase order changed').toBeGreaterThan(previous);
      previous = index;
    }
    expect(phases.find((row: any) => row.phase === 'core-witness-verified')).toMatchObject({
      coreMode: 'compiled', witnessSchemaVersion: 1, sourceSha256: binding.witness.sourceSha256,
      artifactSha256: binding.witness.artifactSha256,
    });
    expect(phases.at(-1)).toMatchObject({ phase: 'core-execution-complete', ok: false });
  }, BUILD_TEST_TIMEOUT_MS);

  it('creates missing gate metadata and records every copied and bundled worker input', () => {
    const common = readFileSync(recipe, 'utf8');
    const copied = [...common.matchAll(/\$repo_root\/([^"\s}]+\.script\.mjs)/g)]
      .map(match => join(REPO_ROOT, match[1]!));
    const bundled = [...common.matchAll(/"\$repo_root\/([^"]+(?:\.worker|-worker)\.(?:ts|mjs))"/g)]
      .map(match => join(REPO_ROOT, match[1]!));
    expect(copied.length).toBeGreaterThan(0);
    expect(bundled.length).toBeGreaterThan(0);
    expect(readFileSync(join(gateMeta, 'copied-sources.txt'), 'utf8').trim().split('\n')).toEqual(copied);
    const metafiles = readdirSync(gateMeta).filter(name => name.endsWith('.meta.json'));
    // Every esbuild compile writes a metafile: the TypeScript workers and the esbuilt scripts.
    expect(metafiles.sort()).toEqual([...ESBUILD_WORKERS.map(worker => worker.output), ...esbuiltScriptWorkers()]
      .map(name => `${name}.meta.json`).sort());
    expect(bundled.map(source => relative(REPO_ROOT, source)).sort()).toEqual(ESBUILD_WORKERS.map(worker => worker.source).sort());
    const inputs = metafiles.flatMap(name => Object.keys(JSON.parse(readFileSync(join(gateMeta, name), 'utf8')).inputs))
      .map(path => resolve(REPO_ROOT, path));
    for (const source of bundled) expect(inputs).toContain(source);
  });

  it('stages precision benchmark data fixtures beside the worker entry', () => {
    const sourceDir = join(REPO_ROOT, 'packages/operator-core/lib/memory/bench/fixtures');
    const outputDir = join(output, 'fixtures');
    for (const fixture of ['corpus.v1.json', 'gold-set.v1.json']) {
      expect(readFileSync(join(outputDir, fixture), 'utf8'), fixture)
        .toBe(readFileSync(join(sourceDir, fixture), 'utf8'));
    }
  });

  it('starts the admission worker without executing imported CLI entrypoints', async () => {
    const worker = new Worker(join(output, 'admission-jobs.worker.mjs'), {
      execArgv: [], stdout: true, stderr: true,
    });
    let stdout = '', stderr = '';
    worker.stdout.on('data', (chunk) => { stdout += chunk; });
    worker.stderr.on('data', (chunk) => { stderr += chunk; });
    const message = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`admission worker did not respond: ${stdout}${stderr}`)); }, 5_000);
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', received);
        worker.off('error', failed);
        worker.off('exit', exited);
      };
      const received = (value: Record<string, unknown>) => { cleanup(); resolve(value); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const exited = (code: number) => { cleanup(); reject(new Error(`admission worker exited before its response: ${code}; ${stdout}${stderr}`)); };
      worker.once('message', received);
      worker.once('error', failed);
      worker.once('exit', exited);
    });
    try {
      expect(await message()).toEqual({ type: 'ready' });
      const result = message();
      worker.postMessage({ id: 1, job: { kind: 'git', argv: ['rev-parse', '--show-toplevel'], cwd: REPO_ROOT } });
      expect(await result).toMatchObject({ type: 'result', id: 1, ok: true,
        value: { status: 0, stdout: `${REPO_ROOT}\n` } });
    } finally {
      await worker.terminate();
    }
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  }, 15_000);

  it('names a gate metadata directory that cannot be created before publishing workers', () => {
    const blocked = join(output, 'gate-meta-blocked-by-file');
    writeFileSync(blocked, 'not a directory');
    const result = build({ BUNDLE_HOST_GATE_META_DIR: join(blocked, 'meta') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FATAL: cannot create the restricted-hold gate meta dir ${join(blocked, 'meta')}`);
  }, BUILD_TEST_TIMEOUT_MS);

  it('names the copied source when gate bookkeeping cannot be written', () => {
    const blocked = join(output, 'gate-meta-append-blocked');
    mkdirSync(join(blocked, 'copied-sources.txt'), { recursive: true });
    const result = build({ BUNDLE_HOST_GATE_META_DIR: blocked });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FATAL: cannot record ${join(REPO_ROOT, 'libs/generic/memory/src/local-embedder-worker.script.mjs')}`);
    expect(result.stderr).toContain(`${join(blocked, 'copied-sources.txt')} for the restricted-hold gate`);
  }, BUILD_TEST_TIMEOUT_MS);

  // WI-6554700010048806: since 3dcc6d094b1 the recipe copies the testing-core metafile into the
  // gate directory before the first worker, so omitting the mkdir now fails before ANY worker is
  // published. The control still proves the mkdir is what lets the real build succeed.
  it('control: omitting only metadata directory creation fails before publishing any worker', () => {
    const original = readFileSync(recipe, 'utf8');
    const mkdir = '! mkdir -p "$BUNDLE_HOST_GATE_META_DIR"';
    expect(original.split(mkdir)).toHaveLength(2);
    const subject = join(output, 'recipe-without-gate-mkdir.sh');
    writeFileSync(subject, original.replace(mkdir, '! true'));
    const destination = join(output, 'first-worker-control');
    const meta = join(output, 'absent-control-meta');
    const result = build({ BUNDLE_HOST_GATE_META_DIR: meta }, subject, destination);
    expect(result.status, budgetNote(result.status) + result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`FATAL: cannot record testing-core.worker.mjs.meta.json in ${meta} for the restricted-hold gate`);
    expect(existsSync(join(destination, 'testing-core.worker.mjs'))).toBe(true);
    expect(existsSync(join(destination, 'local-embedder-worker.script.mjs'))).toBe(false);
    expect(existsSync(join(destination, 'cpu-task-worker.script.mjs'))).toBe(false);
    expect(existsSync(meta)).toBe(false);
  }, BUILD_TEST_TIMEOUT_MS);

  it('runs snapshot compaction in the emitted worker without a TypeScript loader', async () => {
    const worker = new Worker(join(output, 'snapshot-fold.worker.mjs'), { execArgv: [] });
    const request = (message: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('bundled worker response timed out')); }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      const onMessage = (response: Record<string, unknown>) => { cleanup(); resolve(response); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.postMessage(message);
    });
    try {
      expect(await request({ kind: 'init', id: 1, excludeTables: [] })).toEqual({ kind: 'ok', id: 1 });
      const block = new TextEncoder().encode(JSON.stringify({
        type: 'put', table: 'test', hbKey: 'row', value: { answer: 42 },
        ts: 1, schema_version: 1, author_pubkey: 'test',
      }));
      expect(await request({ kind: 'fold', id: 2, buf: block.buffer.slice(0), lengths: [block.byteLength] }))
        .toMatchObject({ kind: 'folded', decodedOps: 1, keyCount: 1 });
      // P-006 index fold: the scan keeps only positions, so the caller re-reads the
      // winning blocks and hands them back before `finish` can serialize rows.
      expect(await request({ kind: 'pending', id: 3 })).toEqual({ kind: 'pending', id: 3, indexes: [0] });
      expect(await request({
        kind: 'materialize', id: 4, buf: block.buffer.slice(0), lengths: [block.byteLength], indexes: [0], now: 2,
      })).toMatchObject({ kind: 'materialized', remaining: 0 });
      const result = await request({
        kind: 'finish', id: 5, now: 2, coversUpTo: 1, author_pubkey: 'test',
        ts: 2, schema_version: 1, excludeTables: [],
      });
      expect(result).toMatchObject({ kind: 'finished', rowCount: 1 });
      expect(new TextDecoder().decode(result.buf as ArrayBuffer)).toContain('"answer":42');
    } finally {
      await worker.terminate();
    }
  }, 15_000);

  it('runs the emitted closure compiler in plain Node and preserves its import graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundled-closure-'));
    writeFileSync(join(dir, 'entry.ts'), 'export { value } from "./subject.ts";');
    writeFileSync(join(dir, 'subject.ts'), 'export const value = 1;');
    try {
      // Exercise the production fork/advanced-IPC door, including its awaited
      // owned-tree cleanup. A thread-only check misses process-entry failures.
      const result = await testImportClosures(dir, [join(dir, 'entry.ts')], {
        workerPath: join(output, 'mutation-probe-closure.worker.mjs'),
      });
      expect(result.status).toBe('complete');
      if (result.status === 'complete') expect(result.files.get(join(dir, 'entry.ts'))).toContain(join(dir, 'subject.ts'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 10_000);

  it('refuses an unavailable required source even when an older bundle exists', () => {
    const before = readFileSync(join(output, 'local-embedder-worker.script.mjs'), 'utf8');
    const result = build({ PAPERCUSP_EMBED_WORKER_SCRIPT: join(output, 'does-not-exist.mjs') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FATAL: missing runtime worker');
    expect(readFileSync(join(output, 'local-embedder-worker.script.mjs'), 'utf8')).toBe(before);
  }, BUILD_TEST_TIMEOUT_MS);
});

describe('worker scripts are staged beside every bundled entry', () => {
  const scripts = findWorkerScripts(REPO_ROOT);

  it('derived the known runtime-sibling population from the shared recipe', () => {
    expect(REQUIRED_RUNTIME_SIBLING_ASSETS.map(({ output }) => output)).toEqual(
      expect.arrayContaining(['systemd-scope-env-runner.mjs', 'git-ext-bridge.mjs']),
    );
  });

  it('found every explicitly required sibling runtime asset', () => {
    const missingSources = REQUIRED_RUNTIME_SIBLING_ASSETS.filter(
      ({ source }) => !existsSync(resolve(REPO_ROOT, source)),
    );

    expect(
      missingSources,
      'The sibling-asset guard must not go green because a required source disappeared.',
    ).toEqual([]);
  });

  it('found the known esbuild-worker population', () => {
    const missingSources = ESBUILD_WORKERS.filter(({ source }) => !existsSync(resolve(REPO_ROOT, source)));

    expect(
      missingSources,
      'The esbuild-worker guard must not go green because its source population disappeared.',
    ).toEqual([]);
  });

  it('found the known worker-script population', () => {
    // A zero-length scan would make every assertion below vacuously true — the
    // same zero-work false-green this repo has paid for repeatedly (a tsc run
    // checking no files, an affected-tests run selecting no suites).
    expect(scripts.length).toBeGreaterThanOrEqual(3);
  });

  for (const bundler of BUNDLERS) {
    it(`stages every source *.script.mjs — ${bundler.label}`, () => {
      const executable = bundlerExecutable(bundler.path);

      const missing = scripts
        .map((s) => relative(REPO_ROOT, s))
        .filter((rel) => !executable.includes(rel.slice(rel.lastIndexOf('/') + 1)));

      expect(
        missing,
        `These worker scripts are not staged by ${bundler.label}. In the dev tree they resolve ` +
          `fine (the script sits next to its module), so this ONLY breaks in the bundle — and ` +
          `every such worker has an inline fallback, so it degrades SILENTLY to main-thread ` +
          `work instead of failing. Add a copy step next to the existing ones in ` +
          `${relative(REPO_ROOT, bundler.path)}.`,
      ).toEqual([]);
    });

    it(`stages every source esbuild worker — ${bundler.label}`, () => {
      const executable = bundlerExecutable(bundler.path);

      const missing = ESBUILD_WORKERS.filter(({ output }) => !executable.includes(output));

      expect(
        missing.map(({ source, output }) => `${source} → ${output}`),
        `These TypeScript workers are not esbuild-staged by ${bundler.label}. ` +
          'They cannot load in the packaged plain-node runtime when copied as .ts.',
      ).toEqual([]);
    });

    it(`stages every required sibling runtime asset — ${bundler.label}`, () => {
      const executable = siblingExecutable(bundler.path);
      const missing = REQUIRED_RUNTIME_SIBLING_ASSETS.filter(
        ({ output }) => !executable.includes(output),
      );

      expect(
        missing.map(({ source, output }) => `${source} → ${output}`),
        `These runtime assets resolve beside the executing module and therefore must be ` +
          `staged beside ${bundler.label}'s bundled entry.`,
      ).toEqual([]);
    });
  }
});
