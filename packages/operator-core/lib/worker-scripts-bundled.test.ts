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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join, relative, resolve } from 'node:path';

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

/** Worker entries whose source is TypeScript and whose bundlers must run an
 * esbuild pass instead of copying a sibling `.script.mjs` asset. */
const ESBUILD_WORKERS: { source: string; output: string }[] = [
  {
    source: 'packages/operator-core/lib/event-loop-sentinel.worker.ts',
    output: 'event-loop-sentinel.worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/sync/hyperbee/snapshot-fold.worker.ts',
    output: 'snapshot-fold.worker.mjs',
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
  const recipe = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');
  const build = (extraEnv: NodeJS.ProcessEnv = {}) => spawnSync('bash', [
    '-c', 'source "$1"; bundle_host_workers "$2" "$3" "${PAPERCUSP_EMBED_WORKER_SCRIPT:-}"', 'worker-recipe-test', recipe, REPO_ROOT, output,
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env, PAPERCUSP_EMBED_WORKER_SCRIPT: '', ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });

  beforeAll(() => {
    output = mkdtempSync(join(tmpdir(), 'bundled-workers-'));
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(output, 'node_modules'), 'dir');
    const result = build();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 40_000);

  afterAll(() => {
    if (output) rmSync(output, { recursive: true, force: true });
  });

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

  it('refuses an unavailable required source even when an older bundle exists', () => {
    const before = readFileSync(join(output, 'local-embedder-worker.script.mjs'), 'utf8');
    const result = build({ PAPERCUSP_EMBED_WORKER_SCRIPT: join(output, 'does-not-exist.mjs') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FATAL: missing runtime worker');
    expect(readFileSync(join(output, 'local-embedder-worker.script.mjs'), 'utf8')).toBe(before);
  });
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
