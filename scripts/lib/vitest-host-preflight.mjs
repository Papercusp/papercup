// The papercusp HOST PREFLIGHT for vitest (WI-10005724, follow-up of WI-10005713 / WI-10005634 —
// plan personal-data-reader-set-labels-2026-10-01, BAR R-11, Decision D-012).
//
// libs/test-config is a generic submodule, so it carries no papercusp policy. Its
// host-preflight globalSetup loads THIS module by convention (<monorepo root>/scripts/lib/
// vitest-host-preflight.mjs) after vitest has resolved the run's files and before any test
// executes, and calls `hostPreflight`. A repository without this file runs no preflight.
//
// The runtime preflight policy is the restricted-write fence: refuse to execute code a
// session holding an active personal disclosure wrote, from a process that has the network.
// testing:run and the raw router already apply it; this is the door for `npx vitest` and the
// per-workspace vitest runs `npm run test:affected` starts.
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  formatVitestRestrictedHoldRefusal,
  runVitestRootPreflight,
} from './restricted-hold-preflight.mjs';

// The fixture uses these same names so name-filter admission cannot drift when
// a scenario is renamed or added. Only these cases need immutable dependencies.
export const NATIVE_QUALIFICATION_SUITE_NAME = 'checkpoint qualification lifecycle (real row lock and JSONB)';
export const NATIVE_QUALIFICATION_CASE_NAME = 'keeps a real acknowledged file banked across %s and executes only its unfinished peer';
export const NATIVE_QUALIFICATION_SCENARIOS = Object.freeze(['SIGTERM', 'SIGKILL', 'primary-yield', 'original-ledger']);

/** Keep native config imports behind the committed-source loader before Vitest
 * can transform them. Shared by the router and direct native fixture producers.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [execArgv]
 */
export function vitestConfigLoaderPolicy(args, env = process.env, execArgv = process.execArgv) {
  let selected = null;
  const remaining = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--configLoader') selected = args[++i] ?? '';
    else if (arg.startsWith('--configLoader=')) selected = arg.slice('--configLoader='.length);
    else remaining.push(arg);
  }
  const guarded = `${env.NODE_OPTIONS ?? ''} ${execArgv.join(' ')}`.includes('committed-source-loader.mjs');
  if (guarded && selected !== null && !['native', 'bundle'].includes(selected)) {
    throw new Error('committed-source config requires --configLoader native or bundle; runner transforms bypass its source boundary');
  }
  // Bundles retain Vite's dependency census. The committed-source loader checks
  // every inline source-map input against HEAD and refuses dirty/unverifiable
  // bundles; keep that guard installed. Native remains the default because it
  // can substitute HEAD bytes in a dirty shared config.
  if (guarded && selected === null) selected = 'native';
  return { configLoaderArgs: selected === null ? [] : ['--configLoader', selected], vitestArgs: remaining };
}

/** Native fixtures inherit the committed-source loader, while Vitest reads local
 * test modules. Refuse mixed tracer inputs before any native child is launched.
 * Reuse the cost-fixture's Git-blob comparison without importing the loader:
 * importing that module installs process-wide hooks.
 * @param {{ root: string, files: string[] }} input
 * @param {{ committed?: (root: string, path: string) => Buffer,
 *   working?: (path: string) => Buffer }} [readers]
 */
export function nativeChildSourcePreflight({ root, files }, readers = {}) {
  const suites = [
    'packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts',
    'packages/operator-core/test/committed-reader-source-preflight.test.ts',
  ];
  const selected = files.map(file => relative(root, isAbsolute(file) ? file : resolve(root, file)).replaceAll('\\', '/'))
    .filter(file => suites.includes(file));
  if (!selected.length) return null;
  const committed = readers.committed ?? ((cwd, path) => {
    const absolute = resolve(cwd, path);
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    const options = { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      stdio: /** @type {['ignore', 'pipe', 'pipe']} */ (['ignore', 'pipe', 'pipe']) };
    // Shared test-config is a real submodule: its blob lives in its own HEAD.
    const top = execFileSync('git', ['-C', dirname(absolute), 'rev-parse', '--show-toplevel'], options).toString().trim();
    return execFileSync('git', ['-C', top, 'show', `HEAD:${relative(top, absolute).replaceAll('\\', '/')}`], options);
  });
  const working = readers.working ?? readFileSync;
  for (const path of [
    'scripts/lib/vitest-startup-trace.mjs',
    'packages/operator-core/lib/process-identity.ts',
    'libs/test-config/src/configuration-snapshot.ts',
    'libs/test-config/src/executed-config-load-capture.ts',
    ...new Set(selected),
  ]) {
    try {
      if (committed(root, path).equals(working(resolve(root, path)))) continue;
    } catch {
      return { verdict: 'refuse', message: `NATIVE_CHILD_SOURCE_REFUSED measured=none unreadable committed input: ${path}` };
    }
    return { verdict: 'refuse', message: `NATIVE_CHILD_SOURCE_REFUSED measured=none ${path} must match HEAD before native child verification; wait for git-sync` };
  }
  return null;
}

/** Check the native qualification fixture's exact dependency prerequisite before
 * baseline PG setup. This only reads the maintained selector; the fixture must
 * still select and lease it at execution time. No install, publication or proof
 * authorization is performed here.
 * @param {{ root: string, files: string[], env: NodeJS.ProcessEnv, testNamePattern?: RegExp }} input
 * @param {{ hasMarker?: (path: string) => boolean,
 *   probe?: (root: string, env: NodeJS.ProcessEnv) => { status: number | null,
 *     stdout?: string, stderr?: string, error?: unknown } }} [readers]
 */
export function nativeChildDependencyPreflight({ root, files, env, testNamePattern }, readers = {}) {
  const suite = 'packages/operator-core/lib/release/checkpoint-qualification-lifecycle.integration.test.ts';
  if (!files.some(file => relative(root, resolve(root, file)).replaceAll('\\', '/') === suite)) return null;
  if (testNamePattern instanceof RegExp && !NATIVE_QUALIFICATION_SCENARIOS.some(scenario => {
    // RegExp.test mutates global/sticky patterns. Never depend on lastIndex or
    // change Vitest's resolved filter while deciding whether a case can run.
    const pattern = new RegExp(testNamePattern.source, testNamePattern.flags);
    return pattern.test(`${NATIVE_QUALIFICATION_SUITE_NAME} ${NATIVE_QUALIFICATION_CASE_NAME.replace('%s', scenario)}`);
  })) return null;
  // The fixture uses an already-materialized immutable install when present.
  // Its runtime reader separately authenticates that marker and dependency bytes.
  if ((readers.hasMarker ?? existsSync)(resolve(root, 'node_modules/.papercusp-dependency-generation'))) return null;
  const probe = readers.probe ?? ((sourceRoot, environment) => spawnSync('bash', ['-c',
    'source "$1" || exit $?; origin=$(git -C "$2" remote get-url origin) || exit $?; owner="$2"; ' +
    'if [[ "$origin" == /* && -d "$origin" ]]; then owner="$origin"; fi; ' +
    'store=$(dependency_generation_resolve_root "$owner" "" 1) || exit $?; ' +
    'input=$(dependency_generation_input_fingerprint "$2") || exit $?; ' +
    'printf "PREREQUISITE_INPUT=%s\\nPREREQUISITE_STORE=%s\\n" "$input" "$store"; ' +
    'dependency_generation_select_input_fingerprint "$input" "$store" || exit $?; ' +
    'printf "PREREQUISITE_GENERATION=%s\\n" "$DEPENDENCY_GENERATION_ID"',
    '--', resolve(sourceRoot, 'apps/operator/bin/release/dependency-generation.sh'), sourceRoot],
  { env: environment, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 }));
  let result;
  try { result = probe(root, env); }
  catch (error) { result = { status: null, error }; }
  const fields = Object.fromEntries((result.stdout ?? '').split('\n')
    .filter(line => line.startsWith('PREREQUISITE_')).map(line => {
      const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const input = /^[a-f0-9]{64}$/.test(fields.PREREQUISITE_INPUT ?? '') ? fields.PREREQUISITE_INPUT : null;
  const store = fields.PREREQUISITE_STORE?.startsWith('/') ? fields.PREREQUISITE_STORE : null;
  const generation = /^v1-[a-f0-9]{64}$/.test(fields.PREREQUISITE_GENERATION ?? '')
    ? fields.PREREQUISITE_GENERATION : null;
  if (result.status === 0 && input && store && generation) return null;
  return { verdict: 'refuse', message: 'NATIVE_CHILD_DEPENDENCY_REFUSED ' + JSON.stringify({
    schemaVersion: 'native-child-dependency-prerequisite-v1',
    status: result.status === 74 && input && store ? 'unavailable' : 'unmeasured',
    inputFingerprint: input, generationRoot: store, exitCode: result.status,
    nextAction: 'Existing dependency publisher must provide this exact input; do not install or substitute a generation.',
  }) };
}

/**
 * Contract (owned by libs/test-config/src/host-preflight-global-setup.ts):
 *   → { verdict: 'admit', setEnv? } | { verdict: 'skipped', reason } | { verdict: 'refuse', message }
 * A refusal aborts the vitest run with `message`; `setEnv` is applied to vitest's main-process env.
 * @param {{ root: string, files: string[], env: NodeJS.ProcessEnv, testNamePattern?: RegExp }} input
 */
export function hostPreflight({ root, files, env, testNamePattern }) {
  const sourceRefusal = nativeChildSourcePreflight({ root, files });
  if (sourceRefusal) return sourceRefusal;
  const dependencyRefusal = nativeChildDependencyPreflight({ root, files, env, testNamePattern });
  if (dependencyRefusal) return dependencyRefusal;
  const result = runVitestRootPreflight({ repoRoot: root, files, env });
  if (result.verdict === 'refuse') return { verdict: 'refuse', message: formatVitestRestrictedHoldRefusal(result) };
  return result;
}

/**
 * A vitest globalSetup for the standalone packages that cannot import @papercusp/test-config
 * (scripts/check-vitest-config-enrollment.mjs PLAIN_CONFIG_EXEMPTIONS, WI-10005765). Each such
 * config walks up to this file and lists it in `globalSetup` only when it exists, so a standalone
 * clone runs none. Same semantics as test-config's runHostPreflight: refuse throws before any test
 * runs; admit sets the marker in vitest's main-process env.
 * @param {{ vitest: { state: { getPaths(): string[] }, config?: { testNamePattern?: RegExp } } }} project
 */
export async function setup(project) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = hostPreflight({ root, files: project.vitest.state.getPaths(), env: process.env,
    testNamePattern: project.vitest.config?.testNamePattern });
  if (result.verdict === 'refuse') throw new Error(result.message);
  if (result.verdict === 'admit') Object.assign(process.env, result.setEnv ?? {});
}
