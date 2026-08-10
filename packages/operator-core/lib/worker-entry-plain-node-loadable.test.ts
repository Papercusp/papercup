/**
 * A worker ENTRY must be loadable WITHOUT any ESM loader hooks.
 *
 * ## The trap
 *
 * `new Worker(path)` starts a thread with a FRESH module registry. Loader hooks
 * registered in the parent (tsx's `module.register()`) are NOT inherited. So a
 * `.ts` worker entry is loaded by NODE'S NATIVE type stripping, whose standard
 * ESM resolution has NO extensionless lookup — while every other `.ts` in this
 * package is reached through tsx or vite and resolves extensionless just fine.
 *
 * The entry itself loads. Its extensionless RELATIVE IMPORT is what throws:
 *
 *     Cannot find module '…/lib/event-loop-sentinel'
 *       imported from '…/lib/event-loop-sentinel.worker.ts'
 *
 * ## Why it stayed invisible for so long
 *
 * `new Worker()`'s constructor RETURNS SUCCESSFULLY — resolution happens on the
 * thread, so the failure arrives asynchronously on the 'error' event, after the
 * host has already logged that it armed. Every such host is deliberately
 * fail-soft, so the outcome is a reassuring line ("sentinel disabled, host
 * unaffected") rather than a crash. A typecheck cannot see it either:
 * `moduleResolution: 'bundler'` resolves the extensionless specifier happily,
 * because it is modelling a bundler, not the worker's runtime.
 *
 * Measured on papercup-bg-host, 2026-08-10: 57 arm-then-die cycles in 24h. In
 * one of the resulting unguarded windows the host wedged its event loop for 23
 * minutes (1.13 cores; 101 routines frozen; git-sync and green-checkpoint both
 * stopped) — the exact outage the sentinel exists to bound at ~24s.
 *
 * ## What this guard asserts
 *
 * Membership is anchored to the PROPERTY that makes a file a worker body — it
 * reads `workerData`/`parentPort` from `node:worker_threads` — never to a
 * `*.worker.ts` naming convention. Anchoring to a name is the form-blind
 * mistake that let instances two and four of the sibling-asset class through
 * (see worker-scripts-bundled.test.ts, which guards the OTHER half: that a
 * bundled worker's `.mjs` is staged beside its entry).
 */

import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const LIB_ROOT = resolve(__dirname);
const REPO_ROOT = resolve(__dirname, '../../..');

/** Build output / vendored trees: a copy there is produced by a build step, not source. */
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
  'coverage',
]);

function walk(dir: string, found: string[] = []): string[] {
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
    if (st.isDirectory()) walk(full, found);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/**
 * A worker BODY, by property: it pulls `workerData` or `parentPort` off
 * `node:worker_threads`. A module that merely CONSTRUCTS a Worker is the host
 * half — it runs on the main thread, where the loader is present, so it is
 * deliberately out of scope.
 */
function isWorkerEntry(source: string): boolean {
  // Must IMPORT the binding, not merely mention the word. The host half does
  // `new Worker(entry, { workerData })` — which contains the identifier
  // `workerData` while running on the MAIN thread, where the loader is present.
  // A substring test therefore flags every worker's host as a worker; caught by
  // this guard's own first run, when it reported event-loop-sentinel-host.ts.
  const clause = source.match(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]node:worker_threads['"]/,
  );
  if (!clause) return false;
  const bindings = clause[1]
    .split(',')
    .map((b) => b.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  return bindings.includes('workerData') || bindings.includes('parentPort');
}

/** Relative specifiers only — bare/`node:` ones are resolved by node itself. */
function relativeImportsWithoutExtension(source: string): string[] {
  const out: string[] = [];
  // Static `from '…'` plus dynamic `import('…')`; both resolve on the worker thread.
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;
  for (const m of source.matchAll(re)) {
    const spec = m[1];
    if (!/\.(ts|tsx|mjs|cjs|js|jsx|json|node)$/.test(spec)) out.push(spec);
  }
  return out;
}

describe('worker entries are loadable by plain node (no loader hooks)', () => {
  const workerEntries = walk(LIB_ROOT).filter((f) =>
    isWorkerEntry(readFileSync(f, 'utf8')),
  );

  // CONTROLS — the guard must be able to FAIL, and must not fire on the host
  // half. Asserted against synthetic sources so falsifiability needs no
  // mutation of the shared checkout (where git-sync would commit the mutant
  // mid-probe, and a killed run would never restore it).
  it('CONTROLS: the predicates fire on the bug and stay quiet on the host', () => {
    const workerBody = `import { workerData, parentPort } from 'node:worker_threads';`;
    const hostHalf = `import { Worker } from 'node:worker_threads';\nnew Worker(p, { workerData: d });`;
    const aliased = `import { parentPort as pp } from 'node:worker_threads';`;

    expect(isWorkerEntry(workerBody), 'a real worker body must be detected').toBe(true);
    expect(isWorkerEntry(aliased), 'an aliased binding is still a worker body').toBe(true);
    expect(
      isWorkerEntry(hostHalf),
      'the HOST half only passes workerData as an option — it runs on the main thread',
    ).toBe(false);

    // The regression itself, and the fix, as literal inputs.
    expect(relativeImportsWithoutExtension(`} from './event-loop-sentinel';`)).toEqual([
      './event-loop-sentinel',
    ]);
    expect(relativeImportsWithoutExtension(`} from './event-loop-sentinel.ts';`)).toEqual([]);
    expect(relativeImportsWithoutExtension(`await import('./late.js')`)).toEqual([]);
    expect(relativeImportsWithoutExtension(`await import('./late')`)).toEqual(['./late']);
  });

  it('CONTROL: the scan actually found worker entries', () => {
    // Without this, every assertion below passes vacuously the moment the
    // detection heuristic drifts — the zero-work false-green this repo has paid
    // for repeatedly (a tsc run checking no files, an affected run selecting no
    // suites). If this fires, FIX THE DETECTOR; do not lower the bound.
    expect(
      workerEntries.map((f) => relative(REPO_ROOT, f)),
      'No worker bodies detected under operator-core/lib — isWorkerEntry() has drifted.',
    ).not.toHaveLength(0);
  });

  it('every relative import in a worker entry carries an explicit extension', () => {
    const offenders = workerEntries.flatMap((file) => {
      const bad = relativeImportsWithoutExtension(readFileSync(file, 'utf8'));
      return bad.map((spec) => `${relative(REPO_ROOT, file)} → '${spec}'`);
    });

    expect(
      offenders,
      'These worker entries import a relative module WITHOUT a file extension. The entry ' +
        'itself will load, then throw "Cannot find module" on the worker thread — ' +
        'asynchronously, via the error event, AFTER the host logged that it armed. Because ' +
        'these hosts are fail-soft the process keeps running and the guard is silently off. ' +
        "Add the explicit extension (e.g. './foo.ts'); allowImportingTsExtensions is already " +
        'enabled for this package.',
    ).toEqual([]);
  });

  // The static check above is a proxy. This is the property itself: vitest's
  // pool gives us a plain-node Worker with no tsx hooks — the same environment
  // bg-host's worker thread gets — so spawning the real entry here reproduces
  // the production failure exactly, and would have caught it.
  it('the event-loop sentinel worker actually starts under a plain-node Worker', async () => {
    const entry = join(LIB_ROOT, 'event-loop-sentinel.worker.ts');
    const sab = new SharedArrayBuffer(16 * Int32Array.BYTES_PER_ELEMENT);

    const worker = new Worker(entry, {
      workerData: {
        sab,
        // 'observe' NEVER kills — it only logs what it would do. A 'kill'-mode
        // spawn here would arm a real SIGKILL against the test runner's pid.
        mode: 'observe',
        observeIntervalMs: 2_000,
        thresholds: { wedgeAfterMs: 20_000, observationsToAct: 3, startupGraceMs: 120_000 },
        pid: process.pid,
      },
    });

    const outcome = await new Promise<string>((resolveOutcome) => {
      const timer = setTimeout(() => resolveOutcome('alive'), 3_000);
      worker.on('error', (err) => {
        clearTimeout(timer);
        resolveOutcome(`error: ${String(err).split('\n')[0]}`);
      });
      worker.on('exit', (code) => {
        clearTimeout(timer);
        resolveOutcome(`exited early with code ${code}`);
      });
    });

    await worker.terminate().catch(() => {});

    expect(
      outcome,
      'The sentinel worker did not survive a plain-node spawn, so bg-host is running ' +
        'UNGUARDED against a blocked event loop while still logging "armed".',
    ).toBe('alive');
  }, 15_000);
});
