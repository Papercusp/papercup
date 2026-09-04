/**
 * sidecar-transformers-model-source.test.ts — the guard for EI-22077502575226404.
 *
 * THE BUG. build-desktop-sidecar.sh's WI-5638 / D-178 model check is fail-closed in both
 * directions: exactly the two owner-confirmed ONNX models must be present at the relocated
 * `models/onnx-community/` path, and nothing else. The check is correct; nothing SOURCED
 * the models. They are ~5.1G of RUNTIME downloads into `<transformers>/.cache/onnx-community`
 * that only appear once the host has actually embedded something, and `npm ci` never fetches
 * them — so an ordinary build passed only IMPLICITLY, by running in a host tree whose cache
 * happened to be warm, while a pristine clone (the D-074 clean-source bar) got an empty
 * `.cache`, the D-178 relocation was a no-op, and the build died on the presence check.
 * Measured: P-101 build #3 (task 0mtitqt8x9gpi5thk05) exit 5.
 *
 * THE FIX under test: `bin/lib/transformers-models.sh`, an opt-in source step gated on
 * PAPERCUSP_TRANSFORMERS_MODEL_CACHE. The two properties that matter are opposites, so both
 * are asserted here — it must STAGE the models when a build opts in, and it must change
 * NOTHING when a build does not, because the fail-closed FATAL is the correct outcome for a
 * build that never asked for sourcing.
 *
 * These drive the real helper through its script dispatcher (the lib/pinned-deps.sh
 * contract) rather than text-matching it, so a refusal's exit code and operator-facing
 * message are part of what is verified. Fixtures are byte-sized stand-ins for the weights.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-desktop-sidecar.sh above this test)',
  );
}

const ROOT = repoRoot();

/** Subject paths, overridable so a mutation probe can aim this suite at a COPY. */
const HELPER_PATH =
  process.env.PAPERCUSP_TRANSFORMERS_MODELS_HELPER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'transformers-models.sh');
const BUILD_SCRIPT_PATH =
  process.env.PAPERCUSP_SIDECAR_BUILD_SCRIPT_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');

const MODELS = ['harrier-oss-v1-0.6b-ONNX', 'embeddinggemma-300m-ONNX'] as const;

/** Comments never count — a rule a comment can satisfy is not a rule. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const scratch: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'transformers-models-'));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/**
 * A model directory as the runtime downloader leaves it. `weights:false` reproduces the
 * fragments-only shape an interrupted download leaves behind — the case a bare presence
 * check cannot tell from a finished model.
 */
function makeModel(
  root: string,
  name: string,
  opts: { weights?: boolean; fragments?: boolean; shards?: number } = {},
): void {
  const { weights = true, fragments = false, shards = 1 } = opts;
  const dir = join(root, name, 'onnx');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.onnx'), weights ? 'onnx-graph' : '');
  if (weights) {
    for (let i = 0; i < shards; i++) {
      write(join(dir, i === 0 ? 'model.onnx_data' : `model.onnx_data_${i}`), `shard-${i}`);
    }
  }
  if (fragments) {
    write(join(dir, 'model.onnx_data.tmp.657875.18f1gd2'), 'partial-bytes');
    write(join(dir, 'model.onnx_data.partial'), 'partial-bytes');
  }
  // A config file so the copy has something beside the weights to carry across.
  write(join(root, name, 'config.json'), '{"model_type":"test"}');
}

function runHelper(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string; err: string } {
  // WI-41180: a sync spawn blocks the worker's event loop, so vitest cannot time it out.
  const r = spawnSync('bash', [HELPER_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, PAPERCUSP_TRANSFORMERS_MODEL_CACHE: '', ...env },
  });
  return { code: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

describe('transformers model sourcing — the opt-in step a pristine-clone build needs', () => {
  it('does NOTHING when no build opted in — the fail-closed FATAL stays the correct outcome', () => {
    const t = fixture();
    const modelsRoot = join(t, 'models');
    mkdirSync(modelsRoot, { recursive: true });

    const r = runHelper(['stage', modelsRoot]);

    expect(r.code, r.err).toBe(0);
    // Non-vacuity: staging did not merely fail quietly — it declined to create anything,
    // leaving the downstream presence check to produce the same verdict as before.
    expect(existsSync(join(modelsRoot, 'onnx-community'))).toBe(false);
    expect(r.out).not.toContain('staged transformers models');
  });

  it('stages both models when a build points it at a cache', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const modelsRoot = join(t, 'models');
    for (const m of MODELS) makeModel(src, m, { shards: 2 });

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      expect(readFileSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'), 'utf8')).toBe(
        'onnx-graph',
      );
      // The external-data shards are the bulk of the model; a copy that dropped them would
      // still pass a directory-presence check.
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx_data'))).toBe(true);
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx_data_1'))).toBe(true);
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'config.json'))).toBe(true);
    }
  });

  it('accepts a source dir that IS onnx-community, or its parent', () => {
    const t = fixture();
    const cacheParent = join(t, 'cache');
    for (const m of MODELS) makeModel(join(cacheParent, 'onnx-community'), m);

    const modelsRoot = join(t, 'models');
    const r = runHelper(['stage', modelsRoot], {
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: cacheParent,
    });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'))).toBe(true);
    }
  });

  it('never ships download fragments — they are real, not hypothetical, in a live cache', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const modelsRoot = join(t, 'models');
    for (const m of MODELS) makeModel(src, m, { fragments: true });

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      const onnx = join(modelsRoot, 'onnx-community', m, 'onnx');
      expect(existsSync(join(onnx, 'model.onnx_data.tmp.657875.18f1gd2'))).toBe(false);
      expect(existsSync(join(onnx, 'model.onnx_data.partial'))).toBe(false);
      // ...while the finished weights beside them still crossed.
      expect(existsSync(join(onnx, 'model.onnx_data'))).toBe(true);
    }
  });

  it('does not mistake an atomic .tmp.<pid> parent for a fragment filename', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    // This is the real build shape: build-desktop-sidecar.sh always stages beneath
    // `${SIDECAR_FINAL_DIR}.tmp.$$`. The fragment classifier must inspect only the
    // filename, or every final model.onnx_data shard under this parent is rejected.
    const modelsRoot = join(t, 'darwin-sidecar.tmp.385594', 'node_modules', '@huggingface', 'transformers', 'models');
    for (const m of MODELS) makeModel(src, m, { fragments: true, shards: 2 });

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      const onnx = join(modelsRoot, 'onnx-community', m, 'onnx');
      expect(existsSync(join(onnx, 'model.onnx_data'))).toBe(true);
      expect(existsSync(join(onnx, 'model.onnx_data_1'))).toBe(true);
      expect(existsSync(join(onnx, 'model.onnx_data.tmp.657875.18f1gd2'))).toBe(false);
      expect(existsSync(join(onnx, 'model.onnx_data.partial'))).toBe(false);
    }
  });

  it('REFUSES a fragments-only source rather than staging an interrupted download', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const modelsRoot = join(t, 'models');
    makeModel(src, MODELS[0], { weights: false, fragments: true });
    makeModel(src, MODELS[1]);

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code).not.toBe(0);
    expect(r.err).toContain('no final ONNX weights');
    expect(existsSync(join(modelsRoot, 'onnx-community', MODELS[0]))).toBe(false);
  });

  it('REFUSES a source missing one of the two owner-confirmed models', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    makeModel(src, MODELS[0]);

    const r = runHelper(['stage', join(t, 'models')], {
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src,
    });

    expect(r.code).not.toBe(0);
    expect(r.err).toContain(MODELS[1]);
  });

  it('REFUSES an opt-in that points nowhere, instead of silently no-opting', () => {
    const t = fixture();
    const r = runHelper(['stage', join(t, 'models')], {
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: join(t, 'does-not-exist'),
    });

    // A silent no-op here would be worse than the original bug: the build would still
    // FATAL downstream, but naming the wrong cause.
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('PAPERCUSP_TRANSFORMERS_MODEL_CACHE');
  });

  it('leaves an already-staged tree alone — a host build never silently prefers an outside copy', () => {
    const t = fixture();
    const modelsRoot = join(t, 'models');
    for (const m of MODELS) makeModel(join(modelsRoot, 'onnx-community'), m);
    for (const m of MODELS) {
      writeFileSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'), 'ALREADY-STAGED');
    }
    const other = join(t, 'other-cache', 'onnx-community');
    for (const m of MODELS) makeModel(other, m);

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: other });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      expect(
        readFileSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'), 'utf8'),
      ).toBe('ALREADY-STAGED');
    }
  });
});

describe('the sourcing step is wired into the sidecar build, and its model list cannot drift', () => {
  it('build-desktop-sidecar.sh sources the helper and calls the staging step', () => {
    const script = codeOnly(readFileSync(BUILD_SCRIPT_PATH, 'utf8'));
    expect(script).toContain('lib/transformers-models.sh');
    expect(script).toContain('papercusp_stage_transformers_models');
  });

  it('the transformers branch is NOT gated on a .cache dir existing — that gate WAS the bug', () => {
    // A pristine clone has no `.cache` at all. While the branch was conditioned on one,
    // there was no code path that could ever source the models: the relocation had nothing
    // to relocate and nothing else ran. Restoring that `&& -d "$_transformers_cache"`
    // reinstates the bug verbatim, so it is exactly what this pins.
    const script = readFileSync(BUILD_SCRIPT_PATH, 'utf8');
    expect(script).toContain('if [[ "$cur" == "@huggingface/transformers" ]]; then');
    expect(script).not.toContain('"$cur" == "@huggingface/transformers" && -d "$_transformers_cache"');
    // ...and the staging call really is inside that branch rather than orphaned elsewhere.
    const branch = script.indexOf('if [[ "$cur" == "@huggingface/transformers" ]]; then');
    const call = script.indexOf('papercusp_stage_transformers_models "$_transformers_models"');
    expect(call).toBeGreaterThan(branch);
  });

  it('the helper grades exactly the models the build script requires', () => {
    const names = runHelper(['names']).out.trim().split('\n').filter(Boolean).sort();
    const script = readFileSync(BUILD_SCRIPT_PATH, 'utf8');
    const required = /for _required_model in ([^\n;]+); do/.exec(script);

    // If the presence-check loop is ever restructured this regex stops matching, and the
    // failure is the point: the two lists are hand-maintained copies of one fact, so the
    // pin has to break loudly rather than quietly stop comparing anything.
    expect(required, 'could not find the presence-check loop in build-desktop-sidecar.sh').not.toBeNull();
    expect(names).toEqual(required![1]!.trim().split(/\s+/).sort());
    expect(names).toEqual([...MODELS].sort());
  });
});
