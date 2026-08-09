/**
 * Every worker script that resolves its own path NEXT TO the executing module
 * must be copied beside the bundle by `bundle-host.sh`.
 *
 * WHY THIS GUARD EXISTS. This failure has now happened THREE times, each time
 * to a different worker, each time silently:
 *
 *  - WI-4196 — `local-embedder-worker.script.mjs` missing from the bundle, so
 *    every embed fell back to inline main-thread ONNX (~6s vs ~36ms).
 *  - EI-19465075959589134 — `cpu-task-worker.script.mjs`, the same class,
 *    labelled in bundle-host.sh itself as "SAME CLASS AS WI-4196 ABOVE, missed
 *    for this worker". :3170 ran at p95 1920ms, 87.5% GC, for an unknown period.
 *  - WI-37555 — `local-reranker-worker.script.mjs`, added with this test.
 *
 * The shape is always identical and is why hand-memory keeps losing to it:
 * `new Worker(resolve(dirname(here), '…script.mjs'))` works perfectly in the dev
 * tree (the script IS next to the module) and fails only in the BUNDLE, where
 * esbuild emits no sibling non-JS assets. Every one of these workers has a
 * deliberate inline fallback, so the failure never throws, never logs an error
 * by default, and reads as "working, just slow". A test is the only thing that
 * catches it at the moment the fourth worker is written rather than months later
 * in a profile.
 *
 * The invariant is deliberately anchored to the PROPERTY that defines
 * membership — a `*.script.mjs` living in a source tree — not to a hand-kept
 * list of known workers, which is exactly the form-blind mistake that let the
 * second instance through.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const BUNDLE_SCRIPT = join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh');

/** Directories that hold BUILD OUTPUT or vendored code, where a `*.script.mjs`
 *  is a COPY produced by the very step under test — counting those would make
 *  this guard pass by observing its own output. */
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

describe('worker scripts are bundled beside the host entry', () => {
  it('copies every source *.script.mjs in bundle-host.sh', () => {
    const bundleSh = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const scripts = findWorkerScripts(REPO_ROOT);

    // A zero-length scan would make this test vacuously pass — the same
    // zero-work false-green that has burned this repo repeatedly (a tsc run
    // checking no files, an affected-tests run selecting no suites). Assert the
    // scan actually found the known population first.
    expect(scripts.length).toBeGreaterThanOrEqual(3);

    const missing = scripts
      .map((s) => relative(REPO_ROOT, s))
      .filter((rel) => {
        const basename = rel.slice(rel.lastIndexOf('/') + 1);
        // The copy must name the file on BOTH sides: a source path to read from
        // and a destination beside the bundle entry.
        return !bundleSh.includes(basename);
      });

    expect(
      missing,
      `These worker scripts are not copied by bundle-host.sh. In the dev tree they resolve ` +
        `fine (the script sits next to its module), so this ONLY breaks in the bundle — and ` +
        `every such worker has an inline fallback, so it degrades silently instead of failing. ` +
        `Add a copy step next to the existing ones in ${relative(REPO_ROOT, BUNDLE_SCRIPT)}.`,
    ).toEqual([]);
  });

  it('names each copy with an $OUTDIR destination, not just a mention', () => {
    const bundleSh = readFileSync(BUNDLE_SCRIPT, 'utf8');
    // A basename appearing only in a comment would satisfy the check above while
    // copying nothing — this pins that each one is a real `cp … "$OUTDIR/…"`.
    const copiedToOutdir = [...bundleSh.matchAll(/cp\s+"[^"]+"\s+"\$OUTDIR\/([^"]+\.script\.mjs)"/g)].map(
      (m) => m[1],
    );
    expect(copiedToOutdir).toContain('local-embedder-worker.script.mjs');
    expect(copiedToOutdir).toContain('cpu-task-worker.script.mjs');
    expect(copiedToOutdir).toContain('local-reranker-worker.script.mjs');
  });
});
