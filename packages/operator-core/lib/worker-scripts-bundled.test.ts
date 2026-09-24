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

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
const REQUIRED_RUNTIME_SIBLING_ASSETS: { source: string; output: string }[] = [
  {
    source: 'packages/operator-core/lib/systemd-scope-env-runner.mjs',
    output: 'systemd-scope-env-runner.mjs',
  },
];

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

describe('worker scripts are staged beside every bundled entry', () => {
  const scripts = findWorkerScripts(REPO_ROOT);

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
      const executable = executableText(readFileSync(bundler.path, 'utf8'));

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
      const executable = executableText(readFileSync(bundler.path, 'utf8'));

      const missing = ESBUILD_WORKERS.filter(({ output }) => !executable.includes(output));

      expect(
        missing.map(({ source, output }) => `${source} → ${output}`),
        `These TypeScript workers are not esbuild-staged by ${bundler.label}. ` +
          'They cannot load in the packaged plain-node runtime when copied as .ts.',
      ).toEqual([]);
    });

    it(`stages every required sibling runtime asset — ${bundler.label}`, () => {
      const executable = executableText(readFileSync(bundler.path, 'utf8'));
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
