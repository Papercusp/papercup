/**
 * WI-4518 — trace-vite-externalized.mjs graph logic: classify an externalized node/server
 * builtin as an EAGER (eval-time white-page risk) reach vs a benign LAZY-chunk reach.
 *
 * The distinction the count gate (check-vite-externalized-warnings.mjs) cannot make: a builtin
 * reached via STATIC `import` edges from the SPA entry blanks the whole app when its module
 * evaluates (the 2026-07-04 / 2026-07-12 incidents); the same builtin behind an `await import()`
 * boundary sits in a lazy chunk and is harmless. Pure functions imported directly (same pattern
 * as check-vite-externalized-warnings.test.ts / lint-tsc.test.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
// @ts-expect-error — the .mjs script has no declaration file (same as test-file-router.test.ts).
import {
  reachableStatic,
  computeEagerExternalized,
  shortestStaticChain,
  decideEager,
  ALLOWED_EAGER_BUILTINS,
  parseJsonFileArg,
} from '../../../scripts/trace-vite-externalized.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// A miniature SPA graph. main → {buffer-polyfill, __root}; __root → provider → reducer →
// {safe-leaf, run-script}. lazyRoute/server-blob are reached ONLY via a dynamic (await import)
// boundary, so they are NOT in `staticEdges` from any eager root.
const staticEdges = new Map<string, string[]>([
  ['/src/main.tsx', ['/src/buffer-polyfill.ts', '/src/routes/__root.tsx']],
  ['/src/buffer-polyfill.ts', []],
  ['/src/routes/__root.tsx', ['/lib/provider.ts']],
  ['/lib/provider.ts', ['/lib/reducer.ts']],
  ['/lib/reducer.ts', ['/lib/safe-leaf.ts', '/lib/run-script.ts']],
  ['/lib/safe-leaf.ts', []],
  ['/lib/run-script.ts', []], // static-reachable, but imports worker_threads DYNAMICALLY (not below)
  ['/lib/lazyRoute.ts', ['/lib/server-blob.ts']], // only reached via a dynamic edge → not eager
  ['/lib/server-blob.ts', []],
]);

// buffer: statically imported by the (eager) polyfill → EAGER.
// child_process: statically imported by server-blob, reachable ONLY lazily → NOT eager.
// worker_threads: absent here — it is imported DYNAMICALLY by run-script, so it never appears in
// builtinStaticImporters at all (importedIds excludes `await import`), which is exactly why the
// old tracer's false "eager worker_threads" alarm cannot recur.
const builtinStaticImporters = new Map<string, Set<string>>([
  ['buffer', new Set(['/src/buffer-polyfill.ts'])],
  ['child_process', new Set(['/lib/server-blob.ts'])],
]);

const eagerRoots = ['/src/main.tsx'];

describe('reachableStatic', () => {
  it('follows static edges from the entry and never crosses a dynamic-only module', () => {
    const reach = reachableStatic(eagerRoots, staticEdges);
    expect(reach.has('/lib/run-script.ts')).toBe(true); // static-reachable
    expect(reach.has('/lib/safe-leaf.ts')).toBe(true);
    expect(reach.has('/lib/lazyRoute.ts')).toBe(false); // dynamic boundary
    expect(reach.has('/lib/server-blob.ts')).toBe(false);
  });

  it('includes the roots themselves', () => {
    expect(reachableStatic(eagerRoots, staticEdges).has('/src/main.tsx')).toBe(true);
  });
});

describe('computeEagerExternalized', () => {
  it('flags a builtin statically imported by a static-reachable module (buffer via the polyfill)', () => {
    const { eager } = computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters });
    expect(eager).toEqual([{ builtin: 'buffer', eagerImporters: ['/src/buffer-polyfill.ts'] }]);
  });

  it('does NOT flag a builtin whose only static importer is reachable ONLY lazily (child_process)', () => {
    const { eager } = computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters });
    expect(eager.find((e: { builtin: string }) => e.builtin === 'child_process')).toBeUndefined();
  });

  it('reports the eager-reachable module count', () => {
    const { reachCount } = computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters });
    // main, buffer-polyfill, __root, provider, reducer, safe-leaf, run-script = 7
    expect(reachCount).toBe(7);
  });

  it('a purely-lazy graph (nothing statically imports a builtin in the reach set) is clean', () => {
    const onlyLazy = new Map<string, Set<string>>([['child_process', new Set(['/lib/server-blob.ts'])]]);
    const { eager } = computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters: onlyLazy });
    expect(eager).toEqual([]);
  });
});

describe('decideEager — the white-page guard verdict', () => {
  it('passes when the only eager reach is an allowlisted browser-polyfilled builtin (buffer)', () => {
    const r = decideEager({ eager: [{ builtin: 'buffer', eagerImporters: ['/src/buffer-polyfill.ts'] }] });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.allowed).toEqual(['buffer']);
  });

  it('FAILS + names the builtin when a non-allowlisted server builtin reaches the SPA eagerly', () => {
    const r = decideEager({
      eager: [
        { builtin: 'buffer', eagerImporters: ['/src/buffer-polyfill.ts'] },
        { builtin: 'worker_threads', eagerImporters: ['/lib/run-script.ts'] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v: { builtin: string }) => v.builtin)).toEqual(['worker_threads']);
  });

  it('an empty eager set is trivially ok', () => {
    expect(decideEager({ eager: [] })).toEqual({ ok: true, violations: [], allowed: [] });
  });

  it('buffer is the only allowlisted eager builtin (allowlist stays minimal)', () => {
    expect([...ALLOWED_EAGER_BUILTINS]).toEqual(['buffer']);
  });
});

describe('shortestStaticChain', () => {
  it('returns the static import chain from an entry to the target module', () => {
    expect(shortestStaticChain(eagerRoots, staticEdges, '/lib/run-script.ts')).toEqual([
      '/src/main.tsx',
      '/src/routes/__root.tsx',
      '/lib/provider.ts',
      '/lib/reducer.ts',
      '/lib/run-script.ts',
    ]);
  });

  it('returns null when the target is not statically reachable', () => {
    expect(shortestStaticChain(eagerRoots, staticEdges, '/lib/server-blob.ts')).toBeNull();
  });
});

describe('trace CLI JSON-file contract', () => {
  it('requires a path for --json-file', () => {
    expect(() => parseJsonFileArg(['--json-file'])).toThrow('--json-file requires a path argument');
    expect(parseJsonFileArg(['--json-file', '/tmp/report.json'])).toBe('/tmp/report.json');
  });

  it('writes parseable JSON through the npm wrapper, whose lifecycle text stays outside the file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trace-vite-json-file-'));
    const reportPath = path.join(dir, 'report.json');
    try {
      execFileSync('npm', ['run', 'trace:vite-externalized:json-file', '--', reportPath], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180_000,
      });

      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        entries?: unknown;
        eagerReachableModules?: unknown;
        eagerExternalized?: unknown;
      };
      expect(Array.isArray(report.entries)).toBe(true);
      expect(report.eagerReachableModules).toEqual(expect.any(Number));
      expect(Array.isArray(report.eagerExternalized)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
