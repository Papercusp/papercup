/**
 * EI-28752668992567658 — a refused testing-core witness must cost only the
 * testing core, never the whole bg-host rebuild.
 *
 * The producing witness (`scripts/lib/testing-core-witness.mjs`) binds the
 * worker's whole input and resolution interval. On the live shared tree that
 * interval is almost never stable across a multi-minute host build, so the
 * witnessed attempt is refused on nearly every restart. Before this fix a refusal
 * returned 1 from `bundle_host_prepare_testing_core` (or from
 * `bundle_host_verify_testing_core`), and bundle-host.sh fell back to a stale
 * last-known-good host bundle: no bg-host fix could load.
 *
 * The fix rebuilds the worker UNWITNESSED, so the bundled testing core fails
 * closed while every other host module ships current code. These cases drive the
 * real shell functions with a stubbed compiler and a fake witness helper, so they
 * run in about a second instead of the minutes a real esbuild build costs.
 *
 * Falsifiability: point PROBE_COMMON at the pre-fix bundle-host-common.sh and the
 * refusal cases fail (prepare/verify return non-zero and the binding stays
 * witnessed or empty).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const COMMON = process.env.PROBE_COMMON || join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');
const DEGRADED = 'unwitnessed:custody-refused';
const UNWITNESSED_DEFINE = '--define:__PAPERCUSP_TESTING_CORE_WITNESS__=undefined';
const WITNESSED_DEFINE = '--define:__PAPERCUSP_TESTING_CORE_WITNESS__="witnessed-digest"';

type WitnessMode = { define: 'ok' | 'refuse'; verify: 'ok' | 'refuse' };
type Outcome = {
  prepareRc: number;
  verifyRc: number | null;
  binding: string;
  define: string;
  compiles: string[];
};

describe('bundle-host testing-core witness refusal (EI-28752668992567658)', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'bh-tc-degrade-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** A throwaway repo whose HEAD carries a fake witness helper, so the
   * prepare step takes the witnessed path instead of the not-committed one. */
  function fakeRepo(mode: WitnessMode): string {
    const repo = join(work, 'repo');
    mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repo, 'scripts/lib/testing-core-witness.mjs'), [
      `const [op] = process.argv.slice(2);`,
      `const mode = ${JSON.stringify(mode)};`,
      `if (op === 'define') {`,
      `  if (mode.define === 'refuse') { console.error('witness: interval changed during compile'); process.exit(3); }`,
      `  console.log(${JSON.stringify(WITNESSED_DEFINE)});`,
      `} else if (op === 'verify') {`,
      `  if (mode.verify === 'refuse') { console.error('witness: interval changed after compile'); process.exit(4); }`,
      `} else { process.exit(64); }`,
    ].join('\n'));
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false', '-C', repo, ...args,
    ], { timeout: 10_000, stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    return repo;
  }

  /** The child env: no inherited binding or fixture opt-in unless a case sets one;
   * an `undefined` override REMOVES the key (e.g. VITEST, which vitest exports). */
  function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, BUNDLE_HOST_TESTING_CORE_RECEIPT: '',
      BUNDLE_HOST_TESTING_CORE_BINDING: '', PAPERCUSP_BUNDLE_HOST_UNWITNESSED_TESTING_CORE: '' };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return env;
  }

  /** Source the real functions, stub the compiler, run prepare (+ optionally verify). */
  function drive(mode: WitnessMode, opts: {
    verify?: boolean; failUnwitnessedCompile?: boolean; env?: Record<string, string | undefined>;
  } = {}): Outcome {
    const repo = fakeRepo(mode);
    const calls = join(work, 'compiles.log');
    writeFileSync(calls, '');
    const script = [
      'source "$1" || exit 90',
      'unset COMMITTED_NODE',
      // Script positionals are captured into globals: inside the stub, $3/$5
      // would name the compiler's own arguments, not this script's.
      'TC_CALLS="$3"; TC_FAIL_UNWITNESSED="$5"',
      // Stub: record whether this compile was the witnessed attempt (it carries
      // the prepare receipt) or the unwitnessed fallback; never run esbuild.
      'bundle_host_esbuild() {',
      '  if [[ -n "${BUNDLE_HOST_TESTING_CORE_PREPARE_RECEIPT:-}" ]]; then',
      '    echo witnessed >> "$TC_CALLS"; echo "witnessed-binding"; return 0',
      '  fi',
      '  echo unwitnessed >> "$TC_CALLS"',
      '  [[ "$TC_FAIL_UNWITNESSED" == 1 ]] && return 1',
      '  return 0',
      '}',
      'bundle_host_prepare_testing_core "$2" "$2/out"; prc=$?',
      'vrc=""',
      'if [[ "$4" == 1 ]]; then bundle_host_verify_testing_core "$2"; vrc=$?; fi',
      'printf "PREPARE_RC=%s\\nVERIFY_RC=%s\\nBINDING=%s\\nDEFINE=%s\\n" "$prc" "$vrc" "${BUNDLE_HOST_TESTING_CORE_BINDING:-}" "${BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE:-}"',
    ].join('\n');
    const out = execFileSync('bash', [
      '-c', `${script}\n`, 'tc-degrade', COMMON, repo, calls,
      opts.verify ? '1' : '0', opts.failUnwitnessedCompile ? '1' : '0',
    ], {
      timeout: 30_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(opts.env),
    });
    const field = (key: string) => (out.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim();
    const verifyRc = field('VERIFY_RC');
    return {
      prepareRc: Number(field('PREPARE_RC')),
      verifyRc: verifyRc === '' ? null : Number(verifyRc),
      binding: field('BINDING'),
      define: field('DEFINE'),
      compiles: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    };
  }

  it('positive control: an accepted witness keeps the witnessed binding and compiles once', () => {
    const r = drive({ define: 'ok', verify: 'ok' }, { verify: true });
    expect(r.prepareRc).toBe(0);
    expect(r.verifyRc).toBe(0);
    expect(r.binding).toBe('witnessed-binding');
    expect(r.define).toBe(WITNESSED_DEFINE);
    expect(r.compiles).toEqual(['witnessed']);
  });

  it('a refused producing witness rebuilds the worker unwitnessed instead of failing the host build', () => {
    const r = drive({ define: 'refuse', verify: 'ok' });
    expect(r.prepareRc).toBe(0);
    expect(r.binding).toBe(DEGRADED);
    expect(r.define).toBe(UNWITNESSED_DEFINE);
    expect(r.compiles).toEqual(['witnessed', 'unwitnessed']);
  });

  it('verification of a degraded worker is skipped, not re-attempted', () => {
    const r = drive({ define: 'refuse', verify: 'refuse' }, { verify: true });
    expect(r.prepareRc).toBe(0);
    expect(r.verifyRc).toBe(0);
    expect(r.binding).toBe(DEGRADED);
    expect(r.compiles).toEqual(['witnessed', 'unwitnessed']);
  });

  it('a verify refusal after a witnessed build replaces the worker unwitnessed so the pair fails closed', () => {
    const r = drive({ define: 'ok', verify: 'refuse' }, { verify: true });
    expect(r.prepareRc).toBe(0);
    expect(r.verifyRc).toBe(0);
    expect(r.binding).toBe(DEGRADED);
    expect(r.define).toBe(UNWITNESSED_DEFINE);
    expect(r.compiles).toEqual(['witnessed', 'unwitnessed']);
  });

  it('still fails the step when the unwitnessed fallback compile itself fails', () => {
    const r = drive({ define: 'refuse', verify: 'ok' }, { failUnwitnessedCompile: true });
    expect(r.prepareRc).not.toBe(0);
    expect(r.binding).not.toBe(DEGRADED);
    expect(r.compiles).toEqual(['witnessed', 'unwitnessed']);
  });
});

describe('bundle-host testing-core VITEST fixture opt-in (EI-28774020156533677)', () => {
  // Drives the same real functions as above, with its own throwaway repo.
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'bh-tc-fixture-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  function run(env: Record<string, string | undefined>): { out: string; compiles: string[] } {
    const repo = join(work, 'repo');
    mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
    // A witness helper that would succeed if it were ever consulted: the opt-in
    // must not consult it, and without the opt-in the witnessed path must run.
    writeFileSync(join(repo, 'scripts/lib/testing-core-witness.mjs'),
      `if (process.argv[2] === 'define') console.log(${JSON.stringify(WITNESSED_DEFINE)});\n`);
    execFileSync('bash', ['-c', 'git init -q && git add -A && git -c user.email=t@example.invalid -c user.name=t '
      + '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm fixture'], { cwd: repo, timeout: 10_000, stdio: 'pipe' });
    const calls = join(work, 'compiles.log');
    writeFileSync(calls, '');
    const out = execFileSync('bash', ['-c', [
      'source "$1" || exit 90',
      'unset COMMITTED_NODE',
      'TC_CALLS="$3"',
      'bundle_host_esbuild() {',
      '  if [[ -n "${BUNDLE_HOST_TESTING_CORE_PREPARE_RECEIPT:-}" ]]; then echo witnessed >> "$TC_CALLS"; echo "witnessed-binding"; return 0; fi',
      '  echo unwitnessed >> "$TC_CALLS"',
      '}',
      'bundle_host_prepare_testing_core "$2" "$2/out"; prc=$?',
      'bundle_host_verify_testing_core "$2"; vrc=$?',
      'printf "PREPARE_RC=%s\\nVERIFY_RC=%s\\nBINDING=%s\\nDEFINE=%s\\n" "$prc" "$vrc" "${BUNDLE_HOST_TESTING_CORE_BINDING:-}" "${BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE:-}"',
    ].join('\n'), 'tc-fixture', COMMON, repo, calls], {
      timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const e: NodeJS.ProcessEnv = { ...process.env, BUNDLE_HOST_TESTING_CORE_RECEIPT: '',
          BUNDLE_HOST_TESTING_CORE_BINDING: '', PAPERCUSP_BUNDLE_HOST_UNWITNESSED_TESTING_CORE: '' };
        for (const [k, v] of Object.entries(env)) { if (v === undefined) delete e[k]; else e[k] = v; }
        return e;
      })(),
    });
    return { out, compiles: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
  }
  const field = (out: string, key: string) => (out.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim();

  it('under VITEST, the opt-in builds the worker UNWITNESSED, never consults the witness, and verify skips', () => {
    const { out, compiles } = run({ VITEST: 'true', PAPERCUSP_BUNDLE_HOST_UNWITNESSED_TESTING_CORE: '1' });
    expect(field(out, 'PREPARE_RC')).toBe('0');
    expect(field(out, 'VERIFY_RC')).toBe('0');
    expect(field(out, 'BINDING')).toBe('unwitnessed:vitest-fixture');
    expect(field(out, 'DEFINE')).toBe(UNWITNESSED_DEFINE);
    expect(compiles).toEqual(['unwitnessed']);
  });

  it('WITHOUT VITEST the opt-in is ignored: a live host build stays witnessed', () => {
    const { out, compiles } = run({ VITEST: undefined, PAPERCUSP_BUNDLE_HOST_UNWITNESSED_TESTING_CORE: '1' });
    expect(field(out, 'PREPARE_RC')).toBe('0');
    expect(field(out, 'BINDING')).toBe('witnessed-binding');
    expect(field(out, 'DEFINE')).toBe(WITNESSED_DEFINE);
    expect(compiles).toEqual(['witnessed']);
  });

  it('under VITEST without the opt-in, the witnessed path still runs', () => {
    const { out, compiles } = run({ VITEST: 'true' });
    expect(field(out, 'BINDING')).toBe('witnessed-binding');
    expect(compiles).toEqual(['witnessed']);
  });
});
